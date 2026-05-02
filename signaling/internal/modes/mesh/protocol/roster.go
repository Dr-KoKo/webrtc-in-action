// Roster-family payload structs (contract §3.4 + §3.5). The 7-state
// presence vocabulary (§FR-013) is hard-coded — adding or removing a
// value here requires a contract revision.

package protocol

// Presence is the 7-element vocabulary from FR-013. The server emits
// `joined`, `media-ready`, `released`, `left` directly; `connecting`,
// `connected`, `failed` are per-(viewer, subject) and derived locally
// by the client from PairContext (data-model §A.6 note).
type Presence string

const (
	PresenceJoined     Presence = "joined"
	PresenceMediaReady Presence = "media-ready"
	PresenceConnecting Presence = "connecting"
	PresenceConnected  Presence = "connected"
	PresenceFailed     Presence = "failed"
	PresenceReleased   Presence = "released"
	PresenceLeft       Presence = "left"
)

// AllPresences is the closed 7-element set. Used by tests to assert
// the enum did not drift.
var AllPresences = []Presence{
	PresenceJoined,
	PresenceMediaReady,
	PresenceConnecting,
	PresenceConnected,
	PresenceFailed,
	PresenceReleased,
	PresenceLeft,
}

func isKnownPresence(p Presence) bool {
	for _, k := range AllPresences {
		if k == p {
			return true
		}
	}
	return false
}

// RosterReason is the `mesh_roster_update.reason` short tag enum
// (§3.5). Forbidden value: any chat-related tag (FR-053).
type RosterReason string

const (
	RosterReasonAdmitted        RosterReason = "admitted"
	RosterReasonMediaReady      RosterReason = "media_ready"
	RosterReasonMediaFailed     RosterReason = "media_failed"
	RosterReasonPairConnecting  RosterReason = "pair_connecting"
	RosterReasonPairConnected   RosterReason = "pair_connected"
	RosterReasonPairFailed      RosterReason = "pair_failed"
	RosterReasonGracefulLeave   RosterReason = "graceful_leave"
	RosterReasonDisconnect      RosterReason = "disconnect"
	RosterReasonPendingReleased RosterReason = "pending_released"
)

func isKnownRosterReason(r RosterReason) bool {
	switch r {
	case RosterReasonAdmitted, RosterReasonMediaReady, RosterReasonMediaFailed,
		RosterReasonPairConnecting, RosterReasonPairConnected, RosterReasonPairFailed,
		RosterReasonGracefulLeave, RosterReasonDisconnect, RosterReasonPendingReleased:
		return true
	}
	return false
}

// RosterParticipant is one entry in `mesh_roster_snapshot.participants`.
type RosterParticipant struct {
	PeerID         string   `json:"peerId"`
	AdmissionIndex uint64   `json:"admissionIndex"`
	Presence       Presence `json:"presence"`
}

// ---------------------------------------------------------------------
// §3.4 mesh_roster_snapshot
// ---------------------------------------------------------------------

type MeshRosterSnapshotPayload struct {
	ServerSeq    uint64              `json:"serverSeq"`
	Participants []RosterParticipant `json:"participants"`
}

func (p *MeshRosterSnapshotPayload) Validate() error {
	if p.Participants == nil {
		return &ProtocolError{Code: CodeMalformed, Message: "mesh_roster_snapshot.participants required"}
	}
	for i, e := range p.Participants {
		if !IsUUID(e.PeerID) {
			return &ProtocolError{Code: CodeMalformed, Message: "mesh_roster_snapshot.participants[].peerId must be a UUID"}
		}
		if e.AdmissionIndex == 0 {
			return &ProtocolError{Code: CodeMalformed, Message: "mesh_roster_snapshot.participants[].admissionIndex must be ≥ 1"}
		}
		if !isKnownPresence(e.Presence) {
			return &ProtocolError{Code: CodeMalformed, Message: "mesh_roster_snapshot.participants[].presence not in 7-element enum"}
		}
		_ = i
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.5 mesh_roster_update
// ---------------------------------------------------------------------

type MeshRosterUpdatePayload struct {
	ServerSeq      uint64       `json:"serverSeq"`
	SubjectPeerID  string       `json:"subjectPeerId"`
	AdmissionIndex uint64       `json:"admissionIndex"`
	Presence       Presence     `json:"presence"`
	Reason         RosterReason `json:"reason"`
}

func (p *MeshRosterUpdatePayload) Validate() error {
	if !IsUUID(p.SubjectPeerID) {
		return &ProtocolError{Code: CodeMalformed, Message: "mesh_roster_update.subjectPeerId must be a UUID"}
	}
	if p.AdmissionIndex == 0 {
		return &ProtocolError{Code: CodeMalformed, Message: "mesh_roster_update.admissionIndex must be ≥ 1"}
	}
	if !isKnownPresence(p.Presence) {
		return &ProtocolError{Code: CodeMalformed, Message: "mesh_roster_update.presence not in 7-element enum"}
	}
	if !isKnownRosterReason(p.Reason) {
		return &ProtocolError{Code: CodeMalformed, Message: "mesh_roster_update.reason not in canonical enum"}
	}
	return nil
}
