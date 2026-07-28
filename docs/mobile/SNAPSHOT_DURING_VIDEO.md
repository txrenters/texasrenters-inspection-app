# Snapshots during video

Evidence follows a wide-to-focused sequence:

1. area overview
2. finding context
3. finding close-up
4. supporting angle or scale/label evidence when needed

On iOS, the app requests a native still from the camera session during recording and labels it
`NATIVE_STILL_DURING_VIDEO`. On Android, Expo Camera does not bind a still-photo use case in video
mode, so the app records a timestamp bookmark and extracts a frame after the video finalizes. Those
images are labelled `VIDEO_FRAME_EXTRACTION`; the UI never presents them as native photographs.

A separate photo taken outside recording is labelled `SEPARATE_PHOTO_CAPTURE`. Every photo stores its
capture session, sequence, optional finding, and video timestamp. Upload failures retain the local file.
