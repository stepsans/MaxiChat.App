import { Feather } from "@expo/vector-icons";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import React, { useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { useColors } from "@/hooks/useColors";

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export type RecordedVoiceNote = { uri: string; name: string; type: string };

/**
 * In-composer voice-note recorder bar. Mounted only while recording is active
 * (WhatsApp-style): starts capture on mount, shows a pulsing red dot + elapsed
 * timer, and offers cancel (discard) / send. The recorded clip is handed back
 * via `onSend` as an uploadable {uri,name,type} for the chat media endpoint.
 */
export function VoiceRecorder({
  onSend,
  onCancel,
}: {
  onSend: (file: RecordedVoiceNote) => void;
  onCancel: () => void;
}) {
  const colors = useColors();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [elapsed, setElapsed] = useState(0);
  const [pulse, setPulse] = useState(true);
  const startedRef = useRef(false);
  const finishedRef = useRef(false);

  // Begin recording on mount; tear down + discard if the user backs out.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let blink: ReturnType<typeof setInterval> | null = null;
    (async () => {
      try {
        const perm = await requestRecordingPermissionsAsync();
        if (!perm.granted) {
          Alert.alert("Izin diperlukan", "Beri akses mikrofon untuk merekam pesan suara.");
          onCancel();
          return;
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
        startedRef.current = true;
        timer = setInterval(() => setElapsed((e) => e + 1), 1000);
        blink = setInterval(() => setPulse((p) => !p), 600);
      } catch {
        Alert.alert("Gagal merekam", "Tidak dapat memulai perekaman.");
        onCancel();
      }
    })();
    return () => {
      if (timer) clearInterval(timer);
      if (blink) clearInterval(blink);
      // Discard the take if the component unmounts without an explicit send.
      if (startedRef.current && !finishedRef.current) {
        recorder.stop().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = async (): Promise<string | null> => {
    finishedRef.current = true;
    try {
      await recorder.stop();
    } catch {
      // ignore
    }
    // Hand the audio session back to playback so voice-note bubbles play at
    // full volume (recording mode routes iOS audio to the earpiece).
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(
      () => {},
    );
    return recorder.uri ?? null;
  };

  const cancel = async () => {
    await stop();
    onCancel();
  };

  const send = async () => {
    const uri = await stop();
    if (!uri) {
      onCancel();
      return;
    }
    onSend({ uri, name: `voice-${elapsed}s.m4a`, type: "audio/mp4" });
  };

  return (
    <View style={[styles.bar, { backgroundColor: colors.secondary }]}>
      <TouchableOpacity onPress={cancel} hitSlop={8} style={styles.iconBtn}>
        <Feather name="trash-2" size={22} color={colors.destructive} />
      </TouchableOpacity>
      <View style={styles.center}>
        <View
          style={[
            styles.dot,
            { backgroundColor: colors.destructive, opacity: pulse ? 1 : 0.25 },
          ]}
        />
        <Text style={[styles.timer, { color: colors.foreground }]}>
          {fmt(elapsed)}
        </Text>
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          Merekam…
        </Text>
      </View>
      <TouchableOpacity
        onPress={send}
        style={[styles.sendBtn, { backgroundColor: colors.primary }]}
      >
        <Feather name="send" size={20} color={colors.primaryForeground} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    height: 48,
    borderRadius: 24,
    paddingHorizontal: 12,
  },
  iconBtn: { padding: 4 },
  center: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  timer: { fontFamily: "Inter_600SemiBold", fontSize: 15 },
  hint: { fontFamily: "Inter_400Regular", fontSize: 13 },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});
