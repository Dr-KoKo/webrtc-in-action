package protocol

import "encoding/json"

// ContractVersion is the wire-protocol version this endpoint speaks.
// Any inbound envelope with `v != 2` MUST be rejected with
// `error { code: "unsupported_version" }` (§3.19). v=1 stays reserved
// for the 001 endpoint; the two values share no message types
// (§7 cross-mode compatibility).
const ContractVersion = 2

// MessageType is the enum of canonical mesh message types (§3.1–§3.18,
// plus the §3.19 `error` type). Only these names are accepted.
type MessageType string

const (
	TypeJoinRoom                   MessageType = "join_room"
	TypeJoinAccepted               MessageType = "join_accepted"
	TypeJoinRejected               MessageType = "join_rejected"
	TypeMeshRosterSnapshot         MessageType = "mesh_roster_snapshot"
	TypeMeshRosterUpdate           MessageType = "mesh_roster_update"
	TypeMediaReady                 MessageType = "media_ready"
	TypeMediaFailed                MessageType = "media_failed"
	TypeParticipantReleased        MessageType = "participant_released"
	TypePairNegotiationInstruction MessageType = "pair_negotiation_instruction"
	TypePairOffer                  MessageType = "pair_offer"
	TypePairAnswer                 MessageType = "pair_answer"
	TypePairIceCandidate           MessageType = "pair_ice_candidate"
	TypePairMediaState             MessageType = "pair_media_state"
	TypeReconnectPair              MessageType = "reconnect_pair"
	TypePairReconnectInstruction   MessageType = "pair_reconnect_instruction"
	TypePairFailed                 MessageType = "pair_failed"
	TypePeerLeft                   MessageType = "peer_left"
	TypeLeaveRoom                  MessageType = "leave_room"
	TypeError                      MessageType = "error"
)

// AllTypes lists every valid mesh MessageType. Order mirrors the
// contract numbering for cross-reference; iteration order is not
// semantically meaningful at runtime.
var AllTypes = []MessageType{
	TypeJoinRoom,
	TypeJoinAccepted,
	TypeJoinRejected,
	TypeMeshRosterSnapshot,
	TypeMeshRosterUpdate,
	TypeMediaReady,
	TypeMediaFailed,
	TypeParticipantReleased,
	TypePairNegotiationInstruction,
	TypePairOffer,
	TypePairAnswer,
	TypePairIceCandidate,
	TypePairMediaState,
	TypeReconnectPair,
	TypePairReconnectInstruction,
	TypePairFailed,
	TypePeerLeft,
	TypeLeaveRoom,
	TypeError,
}

// IsKnownType returns true if t is one of the canonical 19 types.
func IsKnownType(t MessageType) bool {
	for _, k := range AllTypes {
		if k == t {
			return true
		}
	}
	return false
}

// Envelope is the outer JSON wrapper used by every mesh frame.
type Envelope struct {
	V         int             `json:"v"`
	Type      MessageType     `json:"type"`
	RoomID    string          `json:"roomId,omitempty"`
	From      string          `json:"from,omitempty"`
	To        string          `json:"to,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
	TS        int64           `json:"ts,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// Decoded is the tagged union returned by DecodeEnvelope. Message
// carries the concrete payload struct (e.g., *JoinRoomPayload);
// Envelope is always populated.
type Decoded struct {
	Envelope Envelope
	Message  any
}

// validateEnvelope enforces envelope-level rules that apply to all
// types. Per-type envelope-shape rules (e.g., `to` requirements on
// pair messages) live next to the per-type payload structs.
func validateEnvelope(env *Envelope) *ProtocolError {
	if env.From != "" && !IsUUID(env.From) {
		return &ProtocolError{Code: CodeMalformed, Message: "envelope.from must be a UUID"}
	}
	if env.To != "" && !IsUUID(env.To) {
		return &ProtocolError{Code: CodeMalformed, Message: "envelope.to must be a UUID"}
	}
	if env.RequestID != "" && !IsUUID(env.RequestID) {
		return &ProtocolError{Code: CodeMalformed, Message: "envelope.requestId must be a UUID"}
	}
	switch env.Type {
	case TypeJoinRoom:
		if env.RoomID == "" {
			return &ProtocolError{Code: CodeMalformed, Message: "join_room requires envelope.roomId"}
		}
		if env.RequestID == "" {
			return &ProtocolError{Code: CodeMalformed, Message: "join_room requires envelope.requestId"}
		}
	case TypeLeaveRoom, TypeMediaReady, TypeMediaFailed, TypePairMediaState, TypeReconnectPair:
		if env.RoomID == "" {
			return &ProtocolError{Code: CodeMalformed, Message: string(env.Type) + " requires envelope.roomId"}
		}
	case TypePairOffer, TypePairAnswer, TypePairIceCandidate, TypePairFailed:
		if env.RoomID == "" {
			return &ProtocolError{Code: CodeMalformed, Message: string(env.Type) + " requires envelope.roomId"}
		}
		if env.To == "" {
			return &ProtocolError{Code: CodeMalformed, Message: string(env.Type) + " requires envelope.to"}
		}
	}
	return nil
}
