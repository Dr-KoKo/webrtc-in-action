// Chat — Phase 9 (T067, data-model §B.8, spec NFR-006).
//
// Plain-text chat over the RTCDataChannel. The input is disabled
// until the channel reaches `open` (data-model §B.5); messages are
// validated on both sides (validateChatMessage, T068) and rendered
// as text only — no `dangerouslySetInnerHTML`, so an HTML-like
// payload like "<script>" prints verbatim.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRootState } from "../state";
import { usePeerConnection } from "../webrtc/peer-connection-provider";
import { CHAT_MAX_LENGTH } from "../state/chat";

export function Chat() {
  const { chat, dataChannel } = useRootState();
  const { sendChatMessage } = usePeerConnection();
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLOListElement | null>(null);

  const isOpen = dataChannel.state === "open";
  const disabled = !isOpen;

  // Auto-scroll the transcript to the latest message on append. The
  // layout-effect variant runs before paint so the viewport never
  // flashes at the previous position when a new message arrives.
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chat.messages.length]);

  // Clear the per-send error as soon as the user starts typing again
  // so the banner doesn't linger across unrelated attempts.
  useEffect(() => {
    if (sendError && draft.length > 0) setSendError(null);
  }, [draft, sendError]);

  function handleSubmit(ev: FormEvent<HTMLFormElement>): void {
    ev.preventDefault();
    if (disabled) return;
    const result = sendChatMessage(draft);
    if (!result.ok) {
      setSendError(friendlyErrorMessage(result.reason));
      return;
    }
    setDraft("");
    setSendError(null);
  }

  return (
    <section aria-labelledby="chat-heading" className="chat">
      <h2 id="chat-heading">Chat</h2>
      <p className="chat__state" data-testid="chat-channel-state">
        channel: <span>{dataChannel.state}</span>
      </p>
      {chat.messages.length === 0 ? (
        <p className="chat__empty">
          {isOpen
            ? "No messages yet. Say hi."
            : "Chat opens when the DataChannel is ready."}
        </p>
      ) : (
        <ol
          ref={transcriptRef}
          className="chat__transcript"
          role="log"
          aria-live="polite"
        >
          {chat.messages.map((m) => (
            <li
              key={m.id}
              className={`chat__message chat__message--${m.from}`}
              data-testid="chat-message"
              data-from={m.from}
            >
              <span className="chat__author">
                {m.from === "self" ? "You" : "Peer"}:
              </span>{" "}
              {/*
                Safe text rendering only — React escapes child strings
                by default. HTML-like input ("<script>") appears in
                the DOM as text. Never switch this to
                `dangerouslySetInnerHTML` (NFR-006 / Principle VIII).
              */}
              <span className="chat__text">{m.text}</span>
            </li>
          ))}
        </ol>
      )}
      <form className="chat__composer" onSubmit={handleSubmit}>
        <label className="chat__label" htmlFor="chat-input">
          Message
        </label>
        <input
          id="chat-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={disabled}
          maxLength={CHAT_MAX_LENGTH}
          placeholder={
            disabled ? "waiting for DataChannel…" : "type a message"
          }
          data-testid="chat-input"
        />
        <button
          type="submit"
          disabled={disabled || draft.trim().length === 0}
          data-testid="chat-send"
        >
          Send
        </button>
      </form>
      {sendError && (
        <p className="chat__error" role="alert" data-testid="chat-error">
          {sendError}
        </p>
      )}
    </section>
  );
}

function friendlyErrorMessage(reason: string): string {
  switch (reason) {
    case "empty":
      return "Message is empty.";
    case "too-long":
      return `Message exceeds ${CHAT_MAX_LENGTH} characters.`;
    case "not-string":
    case "invalid":
      return "Invalid message.";
    case "not-open":
      return "Chat channel is not open.";
    case "backpressure":
      return "Send buffer is full — wait a moment.";
    default:
      return "Send failed.";
  }
}
