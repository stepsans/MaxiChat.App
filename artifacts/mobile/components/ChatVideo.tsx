import { useVideoPlayer, VideoView } from "expo-video";
import React from "react";
import { StyleSheet } from "react-native";

/**
 * Inline video bubble player. `useVideoPlayer` is a hook, so it must live in
 * its own component — `renderMessage` is a render callback, not a component,
 * and calling hooks there would break the rules of hooks. Shows native
 * controls (play/scrub/fullscreen); does not autoplay or loop.
 */
export function ChatVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.muted = false;
  });

  return (
    <VideoView
      style={styles.video}
      player={player}
      nativeControls
      allowsFullscreen
      contentFit="contain"
    />
  );
}

const styles = StyleSheet.create({
  video: {
    width: 220,
    height: 160,
    borderRadius: 8,
    marginBottom: 4,
    backgroundColor: "#000",
  },
});
