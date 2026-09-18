"use client";

import { useEffect, useRef, useState } from "react";

type WalkthroughResponse = {
  walkthrough?: {
    id: string;
    transcript: string;
    extraction: Record<string, unknown>;
  };
  error?: string;
};

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export default function Recorder({ contactId }: { contactId: string }) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [status, setStatus] = useState<"idle" | "recording" | "processing" | "review" | "approved">("idle");
  const [seconds, setSeconds] = useState(0);
  const [result, setResult] = useState<WalkthroughResponse["walkthrough"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "recording") return;
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [status]);

  async function start() {
    setError(null);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    chunksRef.current = [];
    setSeconds(0);

    recorder.ondataavailable = (event) => {
      if (event.data.size) chunksRef.current.push(event.data);
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const audio = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      const form = new FormData();
      form.set("contactId", contactId);
      form.set("audio", audio, "walkthrough.webm");
      setStatus("processing");

      const response = await fetch("/api/walkthrough", { method: "POST", body: form });
      const json = await response.json() as WalkthroughResponse;
      if (!response.ok || !json.walkthrough) {
        setError(json.error ?? "Walkthrough processing failed");
        setStatus("idle");
        return;
      }
      setResult(json.walkthrough);
      setStatus("review");
    };

    recorder.start(1000);
    setStatus("recording");
  }

  function finish() {
    recorderRef.current?.stop();
  }

  async function approve() {
    if (!result) return;
    const response = await fetch("/api/walkthrough/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walkthroughId: result.id,
        extraction: result.extraction
      })
    });
    const json = await response.json();
    if (!response.ok) {
      setError(json.error ?? "Approval failed");
      return;
    }
    setStatus("approved");
  }

  return (
    <div className="card">
      {status === "idle" && (
        <>
          <h2>Ready</h2>
          <p>Walk the garage and speak naturally. State what stays, goes, moves, gets mounted, and any access or pest notes.</p>
          <button className="button" onClick={start}>START WALKTHROUGH</button>
        </>
      )}

      {status === "recording" && (
        <>
          <div className="muted">Recording</div>
          <div className="timer">{formatTime(seconds)}</div>
          <button className="button danger" onClick={finish}>FINISH</button>
        </>
      )}

      {status === "processing" && (
        <>
          <h2>Processing recording...</h2>
          <p className="muted">Saving audio, transcribing, and extracting job scope.</p>
        </>
      )}

      {status === "review" && result && (
        <div className="review">
          <h2>Walkthrough review</h2>
          <h3>Transcript</h3>
          <pre>{result.transcript}</pre>
          <h3>Structured scope</h3>
          <pre>{JSON.stringify(result.extraction, null, 2)}</pre>
          <button className="button" onClick={approve}>APPROVE & SAVE</button>
        </div>
      )}

      {status === "approved" && (
        <>
          <h2>Approved</h2>
          <p>The reviewed walkthrough scope has been committed to the EGC job record.</p>
        </>
      )}

      {error && <p role="alert">{error}</p>}
    </div>
  );
}
