// Audio page — wraps the AudioSettings component as a full-width page so the
// nav rail's "Audio" tab has a real destination instead of falling through to
// the /dashboard catch-all.

import { AudioSettings } from "../components/AudioSettings";

export function Audio() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 py-2">
      <AudioSettings />
    </div>
  );
}
