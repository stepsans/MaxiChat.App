import { Feather } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import React, { useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface VoiceNoteProps {
  uri: string;
  tint: string;
  trackColor: string;
}

/**
 * Inline voice-note player for audio attachments. Lazily loads the remote audio
 * the first time the user taps play (expo-audio streams from the URI), shows a
 * play/pause toggle, a progress bar, and elapsed / total time.
 */
export function VoiceNote({ uri, tint, trackColor }: VoiceNoteProps) {
  const player = useAudioPlayer({ uri });
  const status = useAudioPlayerStatus(player);

  // When playback reaches the end, reset to the start so the play button works
  // again instead of staying at the final frame.
  useEffect(() => {
    if (status.didJustFinish) {
      player.seekTo(0);
      player.pause();
    }
  }, [status.didJustFinish, player]);

  const duration = status.duration ?? 0;
  const position = status.currentTime ?? 0;
  const progress = duration > 0 ? Math.min(1, position / duration) : 0;
  const playing = status.playing;

  const toggle = () => {
    if (playing) {
      player.pause();
    } else {
      player.play();
    }
  };

  return (
    <View style={styles.row}>
      <TouchableOpacity onPress={toggle} style={[styles.btn, { backgroundColor: tint }]}>
        <Feather name={playing ? "pause" : "play"} size={18} color="#fff" />
      </TouchableOpacity>
      <View style={styles.body}>
        <View style={[styles.track, { backgroundColor: trackColor }]}>
          <View
            style={[styles.fill, { backgroundColor: tint, width: `${progress * 100}%` }]}
          />
        </View>
        <Text style={[styles.time, { color: trackColor }]}>
          {fmt(playing || position > 0 ? position : duration)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, minWidth: 180, paddingVertical: 2 },
  btn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, gap: 4 },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
  time: { fontFamily: "Inter_400Regular", fontSize: 11 },
});
