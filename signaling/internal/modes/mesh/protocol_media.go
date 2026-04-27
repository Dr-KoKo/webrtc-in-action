// Media-readiness payload structs (contract §3.6 + §3.7). Mesh
// inherits 001's no-fallback assumption: a `media_ready` MUST carry
// `audio: true` AND `video: true`. A client unable to deliver both
// MUST send `media_failed` instead.

package mesh

// MediaCapabilities — `media_ready.payload.mediaCapabilities`. Both
// fields are required and required-true for v2 (§3.6).
type MediaCapabilities struct {
	Audio bool `json:"audio"`
	Video bool `json:"video"`
}

// MediaFailedReason — `media_failed.payload.reason` enum (§3.7).
type MediaFailedReason string

const (
	MediaFailedPermissionDenied MediaFailedReason = "permission_denied"
	MediaFailedDeviceNotFound   MediaFailedReason = "device_not_found"
	MediaFailedDeviceInUse      MediaFailedReason = "device_in_use"
	MediaFailedOther            MediaFailedReason = "other"
)

// ---------------------------------------------------------------------
// §3.6 media_ready
// ---------------------------------------------------------------------

type MediaReadyPayload struct {
	MediaCapabilities MediaCapabilities `json:"mediaCapabilities"`
}

func (p *MediaReadyPayload) Validate() error {
	if !p.MediaCapabilities.Audio || !p.MediaCapabilities.Video {
		return &ProtocolError{
			Code:    CodeUnsupportedMediaCapability,
			Message: "media_ready requires audio=true AND video=true (MVP)",
		}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.7 media_failed
// ---------------------------------------------------------------------

type MediaFailedPayload struct {
	Reason MediaFailedReason `json:"reason"`
	Detail string            `json:"detail,omitempty"`
}

func (p *MediaFailedPayload) Validate() error {
	switch p.Reason {
	case MediaFailedPermissionDenied, MediaFailedDeviceNotFound,
		MediaFailedDeviceInUse, MediaFailedOther:
		return nil
	}
	return &ProtocolError{Code: CodeMalformed, Message: "media_failed.reason not in canonical enum"}
}
