"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";

import {
  applyInterpretation,
  initialTeamState,
  labelFor,
  type FieldObject,
  type Interpretation,
  type RequestState,
  type TeamState,
} from "@/lib/lattice";
import { createSupabaseBrowserClient } from "@/lib/supabase";

const sampleUtterances = [
  "I finished most of the landing page but I am waiting on copy from brand.",
  "Ask Priya if I can postpone analytics and focus on the demo flow.",
  "We are no longer optimizing the whole flow, only the walkthrough judges will see.",
  "Remind me at 8 to retry deployment after Rahul fixes the backend.",
];

const requestStates: RequestState[] = ["draft", "sent", "acknowledged", "resolved", "denied"];

function isTeamState(data: TeamState | { error?: string }): data is TeamState {
  return "fieldObjects" in data && "memory" in data && "requests" in data && "reminders" in data;
}

export default function Home() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [teamState, setTeamState] = useState<TeamState>(initialTeamState);
  const [draft, setDraft] = useState(sampleUtterances[0]);
  const [interpretation, setInterpretation] = useState<Interpretation | null>(null);
  const [isInterpreting, setIsInterpreting] = useState(false);
  const [isSavingState, setIsSavingState] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recorderStatus, setRecorderStatus] = useState("Tap the orb or type a signal.");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  useEffect(() => {
    if (!supabase) {
      setIsCheckingAuth(false);
      setRecorderStatus("Supabase is not configured.");
      return;
    }

    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsCheckingAuth(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (!nextSession) {
        setTeamState(initialTeamState);
        setRecorderStatus("Sign in to load the team field.");
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [supabase]);

  const authedFetch = useCallback(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!session) {
      throw new Error("Sign in required.");
    }

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${session.access_token}`);

    return fetch(input, { ...init, headers });
  }, [session]);

  useEffect(() => {
    if (!session) {
      return;
    }

    let isCurrent = true;

    async function loadTeamState() {
      try {
        const response = await authedFetch("/api/team-state");
        const data = (await response.json()) as TeamState | { error?: string };

        if (!response.ok || !isTeamState(data)) {
          setRecorderStatus("Using local demo state.");
          return;
        }

        if (isCurrent) {
          setTeamState(data);
          setRecorderStatus("Supabase team field loaded.");
        }
      } catch {
        if (isCurrent) {
          setRecorderStatus("Using local demo state.");
        }
      }
    }

    void loadTeamState();

    return () => {
      isCurrent = false;
    };
  }, [authedFetch, session]);

  const groupedCounts = useMemo(
    () =>
      teamState.fieldObjects.reduce<Record<string, number>>((counts, object) => {
        counts[object.type] = (counts[object.type] ?? 0) + 1;
        return counts;
      }, {}),
    [teamState.fieldObjects],
  );

  async function interpretDraft(input = draft) {
    const trimmed = input.trim();
    if (!trimmed) return;

    setIsInterpreting(true);
    setRecorderStatus("Lattice is tightening the state.");

    try {
      const response = await authedFetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: trimmed }),
      });
      const nextInterpretation = (await response.json()) as Interpretation;
      if (!response.ok) {
        throw new Error("Interpretation failed.");
      }
      setInterpretation(nextInterpretation);
      setRecorderStatus("Interpretation ready.");
    } catch {
      setRecorderStatus("Could not reach the interpreter.");
    } finally {
      setIsInterpreting(false);
    }
  }

  async function applyLatestInterpretation() {
    if (!interpretation) return;

    setIsSavingState(true);
    setRecorderStatus("Saving the team field.");

    try {
      const response = await authedFetch("/api/team-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: draft, interpretation }),
      });
      const nextTeamState = (await response.json()) as TeamState | { error?: string };

      if (!response.ok || !isTeamState(nextTeamState)) {
        throw new Error("Persistence failed.");
      }

      setTeamState(nextTeamState);
      setInterpretation(null);
      setDraft("");
      setRecorderStatus("Team field saved.");
    } catch {
      setTeamState((current) => applyInterpretation(current, interpretation));
      setInterpretation(null);
      setDraft("");
      setRecorderStatus("Saved locally. Supabase update failed.");
    } finally {
      setIsSavingState(false);
    }
  }

  async function toggleRecording() {
    if (isRecording) {
      recorderRef.current?.stop();
      setIsRecording(false);
      setRecorderStatus("Processing voice signal.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorderRef.current = recorder;

      recorder.addEventListener("dataavailable", (event) => {
        chunksRef.current.push(event.data);
      });

      recorder.addEventListener("stop", async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        stream.getTracks().forEach((track) => track.stop());

        const form = new FormData();
        form.append("audio", blob, "signal.webm");

        try {
          const response = await authedFetch("/api/transcribe", {
            method: "POST",
            body: form,
          });
          const data = (await response.json()) as { text?: string; error?: string };
          if (data.text) {
            setDraft(data.text);
            await interpretDraft(data.text);
          } else {
            setRecorderStatus(data.error ?? "Voice transcription failed.");
          }
        } catch {
          setRecorderStatus("Voice transcription failed.");
        }
      });

      recorder.start();
      setIsRecording(true);
      setRecorderStatus("Listening for a team signal.");
    } catch {
      setRecorderStatus("Microphone access was not available.");
    }
  }

  async function updateRequestState(id: string, state: RequestState) {
    const previous = teamState;

    setTeamState((current) => ({
      ...current,
      requests: current.requests.map((request) => (request.id === id ? { ...request, state } : request)),
    }));

    try {
      const response = await authedFetch("/api/team-state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, state }),
      });
      const nextTeamState = (await response.json()) as TeamState | { error?: string };

      if (!response.ok || !isTeamState(nextTeamState)) {
        throw new Error("Request update failed.");
      }

      setTeamState(nextTeamState);
      setRecorderStatus("Request state saved.");
    } catch {
      setTeamState(previous);
      setRecorderStatus("Request state could not be saved.");
    }
  }

  async function signOut() {
    await supabase?.auth.signOut();
  }

  if (isCheckingAuth) {
    return (
      <main className="shell auth-shell">
        <section className="auth-panel">
          <p className="eyebrow">Lattice V1</p>
          <h1>Checking session</h1>
          <p>Hold on while the field opens.</p>
        </section>
      </main>
    );
  }

  if (!session || !supabase) {
    return <AuthGate onAuthReady={() => setRecorderStatus("Supabase team field loaded.")} />;
  }

  return (
    <main className="shell">
      <section className="topbar" aria-label="Lattice status">
        <div>
          <p className="eyebrow">Lattice V1</p>
          <h1>Team Field</h1>
        </div>
        <div className="intent-pill">
          <span>Current intent</span>
          {teamState.intent}
        </div>
        <button className="sign-out-button" type="button" onClick={signOut}>
          Sign out
        </button>
      </section>

      <section className="workspace" aria-label="Living team state workspace">
        <aside className="rail memory-rail" aria-label="Memory stream">
          <div className="rail-heading">
            <p className="eyebrow">Memory</p>
            <strong>What changed</strong>
          </div>
          <div className="memory-list">
            {teamState.memory.map((event) => (
              <article className="memory-event" key={event.id}>
                <span>{event.at}</span>
                <p>{event.text}</p>
              </article>
            ))}
          </div>
        </aside>

        <section className="field-panel" aria-label="Team Field">
          <div className="field-background" />
          <div className="field-legend" aria-label="Field object counts">
            {Object.entries(groupedCounts).map(([type, count]) => (
              <span key={type}>
                {count} {type}
              </span>
            ))}
          </div>

          <svg className="field-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {teamState.fieldObjects.flatMap((object) =>
              object.links?.map((link) => {
                const target = teamState.fieldObjects.find((candidate) => candidate.id === link);
                if (!target) return null;
                return (
                  <line
                    key={`${object.id}-${link}`}
                    x1={object.x}
                    y1={object.y}
                    x2={target.x}
                    y2={target.y}
                    className={`line-${object.pulse}`}
                  />
                );
              }),
            )}
          </svg>

          {teamState.fieldObjects.map((object) => (
            <FieldNode key={object.id} object={object} />
          ))}
        </section>

        <aside className="rail tension-rail" aria-label="Active tensions">
          <div className="rail-heading">
            <p className="eyebrow">Tensions</p>
            <strong>Needs attention</strong>
          </div>
          <div className="tension-list">
            {teamState.tensions.map((tension) => (
              <p key={tension}>{tension}</p>
            ))}
          </div>
          <div className="broadcast">
            <p className="eyebrow">Broadcast</p>
            {teamState.broadcast.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </aside>
      </section>

      <section className="composer-grid" aria-label="Signal composer and operational consoles">
        <div className="composer">
          <div className="composer-head">
            <div>
              <p className="eyebrow">Signal Composer</p>
              <h2>Speak what changed</h2>
            </div>
            <button
              className={`voice-orb ${isRecording ? "recording" : ""}`}
              type="button"
              onClick={toggleRecording}
              aria-label={isRecording ? "Stop recording" : "Start recording"}
            >
              <span />
            </button>
          </div>

          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Say what happened, what changed, what you need, or what Lattice should ask for."
          />

          <div className="sample-row">
            {sampleUtterances.map((utterance) => (
              <button key={utterance} type="button" onClick={() => setDraft(utterance)}>
                {utterance}
              </button>
            ))}
          </div>

          <div className="composer-actions">
            <span>{recorderStatus}</span>
            <button type="button" onClick={() => interpretDraft()} disabled={isInterpreting || !draft.trim()}>
              {isInterpreting ? "Reading signal" : "Interpret"}
            </button>
          </div>

          {interpretation ? (
            <div className="interpretation">
              <p>{interpretation.reply}</p>
              <div className="entity-row">
                {interpretation.entities.map((entity, index) => (
                  <span key={`${entity.type}-${entity.title}-${index}`}>
                    {labelFor(entity.type)}: {entity.title}
                  </span>
                ))}
              </div>
              {interpretation.followUpQuestion ? (
                <strong>{interpretation.followUpQuestion}</strong>
              ) : null}
              <div className="composer-actions">
                <button type="button" onClick={applyLatestInterpretation} disabled={isSavingState}>
                  {isSavingState ? "Saving field" : "Apply to field"}
                </button>
                <button type="button" onClick={() => setInterpretation(null)}>
                  Edit interpretation
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="console">
          <div>
            <p className="eyebrow">Request Console</p>
            <h2>Delegated asks</h2>
          </div>
          {teamState.requests.map((request) => (
            <article key={request.id} className="request-item">
              <div>
                <span>{request.target}</span>
                <strong>{request.ask}</strong>
                <p>{request.why}</p>
              </div>
              <select value={request.state} onChange={(event) => updateRequestState(request.id, event.target.value as RequestState)}>
                {requestStates.map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </select>
            </article>
          ))}
        </div>

        <div className="console memory-lens">
          <div>
            <p className="eyebrow">Personal Memory</p>
            <h2>Waiting and returning</h2>
          </div>
          {teamState.reminders.map((reminder) => (
            <article key={reminder.id}>
              <span>{reminder.trigger}</span>
              <strong>{reminder.text}</strong>
              <p>Linked to {reminder.linkedTo}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function AuthGate({ onAuthReady }: { onAuthReady: () => void }) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [message, setMessage] = useState("Sign in to open the team field.");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!supabase) {
      setMessage("Supabase is not configured.");
      return;
    }

    setIsSubmitting(true);
    setMessage(mode === "sign-in" ? "Signing in." : "Creating your account.");

    const result =
      mode === "sign-in"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
            options: {
              data: {
                name: name.trim() || email,
              },
            },
          });

    if (result.error) {
      setMessage(result.error.message);
    } else if (result.data.session) {
      onAuthReady();
    } else {
      setMessage("Check your email to confirm your account, then sign in.");
    }

    setIsSubmitting(false);
  }

  return (
    <main className="shell auth-shell">
      <section className="auth-panel">
        <p className="eyebrow">Lattice V1</p>
        <h1>{mode === "sign-in" ? "Sign in" : "Create account"}</h1>
        <p>{message}</p>

        <form className="auth-form" onSubmit={submitAuth}>
          {mode === "sign-up" ? (
            <label>
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
            </label>
          ) : null}
          <label>
            Email
            <input
              autoComplete="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>
          <label>
            Password
            <input
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 6 characters"
              required
              minLength={6}
            />
          </label>
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Working" : mode === "sign-in" ? "Sign in" : "Create account"}
          </button>
        </form>

        <button
          className="auth-switch"
          type="button"
          onClick={() => {
            setMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"));
            setMessage(mode === "sign-in" ? "Create an account for this team field." : "Sign in to open the team field.");
          }}
        >
          {mode === "sign-in" ? "Create a new account" : "I already have an account"}
        </button>
      </section>
    </main>
  );
}

function FieldNode({ object }: { object: FieldObject }) {
  return (
    <article
      className={`field-node ${object.type} ${object.pulse}`}
      style={{
        left: `${object.x}%`,
        top: `${object.y}%`,
      }}
    >
      <span>{labelFor(object.type)}</span>
      <strong>{object.title}</strong>
      <p>{object.detail}</p>
      <small>
        {object.owner ? `${object.owner} · ` : ""}
        {object.status}
      </small>
    </article>
  );
}
