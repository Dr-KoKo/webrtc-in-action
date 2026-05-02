// MeshChat (T063 + T064 + T065 + T066, FR-051..FR-055, L17). Mesh
// group chat surface — one input, one Send button, one rendered list,
// one fan-out summary. The transport is the existing per-pair
// `RTCDataChannel` set up in M6; M8 attaches `onmessage` to each one
// (see `webrtc/dataChannel.ts: attachMeshChatReceiver`).
//
// Display invariants:
//   - One local-echo entry per outgoing send (FR-052a).
//   - One inbound entry per inbound DataChannel message; per-channel
//     arrival order is preserved (FR-055 — no cross-peer reordering).
//   - `dangerouslySetInnerHTML` is NEVER used; user text always
//     reaches the DOM as text, not HTML (NFR-006 / FR-054).
//   - Empty / whitespace-only / >500-char input is rejected at submit
//     and never reaches `dc.send`.

import { useMemo, useState, type FormEvent } from "react";
import { useMeshDispatch, useMeshState } from "../state";
import {
  MESH_CHAT_MAX_LEN,
  validateMeshChatInput,
  type MeshChatFanOut,
} from "../state/chat";
import { fanOutMeshChat } from "../webrtc/dataChannel";
import { useMeshPairManager } from "../signaling/provider";
import { makeMeshEventEntry } from "../state/eventLog";

function uuid(): string {
  // Fall back to a counter-free random hex if `crypto.randomUUID` is
  // missing (older jsdom). The server never reads this id; it just
  // needs to be unique per local send.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `mchat-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

export function MeshChat() {
  const dispatch = useMeshDispatch();
  const state = useMeshState();
  const pairManager = useMeshPairManager();
  const [draft, setDraft] = useState("");
  const localPeerId = state.local.peerId;
  const roomId = state.local.roomId;
  const lastValidationError = state.chat.lastValidationError;

  const messageRows = state.chat.messages;
  const fanOutByMessageId = state.chat.fanOutByMessageId;

  const canSend = useMemo(() => {
    return (
      Boolean(localPeerId) &&
      Boolean(roomId) &&
      (state.local.fsm === "media-ready" || state.local.fsm === "in-room")
    );
  }, [localPeerId, roomId, state.local.fsm]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const validation = validateMeshChatInput(draft);
    if (!validation.ok) {
      const attemptedAt = Date.now();
      dispatch({
        type: "MESH_CHAT_VALIDATION_FAILED",
        reason: validation.reason,
        attemptedAt,
        textLength: validation.trimmed.length,
      });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "local",
          type: "mesh_chat_input_validation_failed",
          summary: `chat input rejected: ${validation.reason}`,
          detail: {
            transport: "datachannel",
            reason: validation.reason,
            textLength: validation.trimmed.length,
          },
        }),
      });
      return;
    }
    if (!canSend || !localPeerId || !roomId || !pairManager) {
      // Defensive — Send is disabled in this state, but a stray
      // submit (e.g. Enter key during async race) should not crash.
      return;
    }
    const messageId = uuid();
    const sentAt = Date.now();
    const pairs = pairManager.listChatPairs();

    // Local echo MUST appear before the per-pair sends and MUST NOT
    // wait for any remote ACK (FR-052a). We dispatch the append + the
    // fan-out summary in one shot; the summary's `succeeded` /
    // `skipped` are computed below.
    const fanOut: MeshChatFanOut = fanOutMeshChat(
      pairs,
      {
        messageId,
        roomId,
        senderPeerId: localPeerId,
        text: validation.trimmed,
        sentAt,
      },
      { dispatch },
    );

    dispatch({
      type: "MESH_CHAT_LOCAL_APPENDED",
      message: {
        id: messageId,
        authorPeerId: localPeerId,
        text: validation.trimmed,
        sentAt,
      },
      fanOut,
    });

    setDraft("");
  };

  const handleChange = (next: string) => {
    setDraft(next);
    if (lastValidationError !== null) {
      dispatch({ type: "MESH_CHAT_VALIDATION_CLEARED" });
    }
  };

  const validationMessage =
    lastValidationError === null
      ? null
      : lastValidationError.reason === "empty"
        ? "Message cannot be empty."
        : `Message must be 500 characters or fewer (got ${lastValidationError.textLength}).`;

  return (
    <section
      className="mesh-chat"
      aria-labelledby="mesh-chat-heading"
      data-testid="mesh-chat"
    >
      <h2 id="mesh-chat-heading">Mesh chat</h2>
      <ol className="mesh-chat__messages" data-testid="mesh-chat-messages">
        {messageRows.length === 0 ? (
          <li
            className="mesh-chat__messages-empty"
            data-testid="mesh-chat-empty"
          >
            (no messages yet)
          </li>
        ) : (
          messageRows.map((m) => {
            const isLocal = m.authorPeerId === localPeerId;
            const fanOut = fanOutByMessageId[m.id];
            return (
              <li
                key={m.id}
                className="mesh-chat__message"
                data-testid="mesh-chat-message"
                data-message-id={m.id}
                data-author-peer-id={m.authorPeerId}
                data-direction={isLocal ? "local" : "remote"}
              >
                <header className="mesh-chat__message-header">
                  <span
                    className="mesh-chat__author"
                    data-testid="mesh-chat-message-author"
                  >
                    {isLocal ? "you" : `peer ${shortId(m.authorPeerId)}`}
                  </span>
                  <span
                    className="mesh-chat__timestamps"
                    data-testid="mesh-chat-message-timestamps"
                  >
                    {m.sentAt !== undefined && (
                      <span data-testid="mesh-chat-message-sent-at">
                        sent {formatClock(m.sentAt)}
                      </span>
                    )}
                    {m.receivedAt !== undefined && (
                      <span data-testid="mesh-chat-message-received-at">
                        received {formatClock(m.receivedAt)}
                      </span>
                    )}
                  </span>
                </header>
                {/* Text-only — never render user input as HTML. */}
                <p
                  className="mesh-chat__text"
                  data-testid="mesh-chat-message-text"
                >
                  {m.text}
                </p>
                {isLocal && fanOut && (
                  <small
                    className="mesh-chat__fanout"
                    data-testid="mesh-chat-message-fanout"
                    data-attempted={fanOut.attempted}
                    data-succeeded={fanOut.succeeded}
                    data-skipped={fanOut.skipped.length}
                  >
                    {fanOut.succeeded} / {fanOut.attempted} delivered
                    {fanOut.skipped.length > 0
                      ? ` · skipped: ${fanOut.skipped
                          .map((s) => `peer ${shortId(s.remotePeerId)} (${s.readyState})`)
                          .join(", ")}`
                      : ""}
                  </small>
                )}
              </li>
            );
          })
        )}
      </ol>
      <form
        className="mesh-chat__form"
        onSubmit={handleSubmit}
        data-testid="mesh-chat-form"
      >
        <label className="mesh-chat__input-label" htmlFor="mesh-chat-input">
          Send to room
        </label>
        <input
          id="mesh-chat-input"
          type="text"
          value={draft}
          onChange={(e) => handleChange(e.target.value)}
          maxLength={MESH_CHAT_MAX_LEN * 2}
          // 2× the limit so the user CAN type a too-long message and
          // see the validation error rather than being silently
          // truncated. Submit-time validation is authoritative.
          placeholder="Say something to the room…"
          disabled={!canSend}
          data-testid="mesh-chat-input"
          aria-describedby="mesh-chat-input-help"
        />
        <button
          type="submit"
          disabled={!canSend}
          data-testid="mesh-chat-send"
        >
          Send
        </button>
        <span id="mesh-chat-input-help" className="mesh-chat__help">
          Up to {MESH_CHAT_MAX_LEN} characters. Group fan-out over
          per-pair DataChannels.
        </span>
        {validationMessage && (
          <p
            role="alert"
            className="mesh-chat__validation-error"
            data-testid="mesh-chat-validation-error"
            data-reason={lastValidationError?.reason}
          >
            {validationMessage}
          </p>
        )}
      </form>
    </section>
  );
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(11, 23);
}
