import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    if (submitting) return;
    setError(null);
    if (!email.trim() || !password) {
      setError("Email dan kata sandi wajib diisi.");
      return;
    }
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Gagal masuk.";
      setError(
        /401|invalid|unauthorized/i.test(msg)
          ? "Email atau kata sandi salah."
          : msg,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.logo, { backgroundColor: colors.primary }]}>
            <Feather name="message-circle" size={36} color="#ffffff" />
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>
            MaxiChat
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            Masuk untuk mengelola percakapan Anda
          </Text>

          <View style={styles.form}>
            <Text style={[styles.label, { color: colors.foreground }]}>Email</Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  color: colors.foreground,
                },
              ]}
              placeholder="nama@perusahaan.com"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
              editable={!submitting}
            />

            <Text style={[styles.label, { color: colors.foreground }]}>
              Kata sandi
            </Text>
            <View style={styles.pwRow}>
              <TextInput
                style={[
                  styles.input,
                  styles.pwInput,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    color: colors.foreground,
                  },
                ]}
                placeholder="••••••••"
                placeholderTextColor={colors.mutedForeground}
                secureTextEntry={!showPw}
                autoCapitalize="none"
                value={password}
                onChangeText={setPassword}
                editable={!submitting}
                onSubmitEditing={onSubmit}
                returnKeyType="go"
              />
              <TouchableOpacity
                style={styles.eye}
                onPress={() => setShowPw((s) => !s)}
              >
                <Feather
                  name={showPw ? "eye-off" : "eye"}
                  size={20}
                  color={colors.mutedForeground}
                />
              </TouchableOpacity>
            </View>

            {error ? (
              <Text style={[styles.error, { color: colors.destructive }]}>
                {error}
              </Text>
            ) : null}

            <TouchableOpacity
              style={[
                styles.button,
                { backgroundColor: colors.primary },
                submitting && { opacity: 0.7 },
              ]}
              onPress={onSubmit}
              disabled={submitting}
              activeOpacity={0.85}
            >
              {submitting ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.buttonText}>Masuk</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 24, alignItems: "center" },
  logo: {
    width: 80,
    height: 80,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  title: { fontFamily: "Inter_700Bold", fontSize: 28 },
  subtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    marginTop: 6,
    marginBottom: 32,
    textAlign: "center",
  },
  form: { width: "100%", maxWidth: 400 },
  label: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    marginBottom: 6,
    marginTop: 14,
  },
  input: {
    height: 50,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontFamily: "Inter_400Regular",
    fontSize: 16,
  },
  pwRow: { position: "relative", justifyContent: "center" },
  pwInput: { paddingRight: 48 },
  eye: { position: "absolute", right: 12, padding: 4 },
  error: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    marginTop: 14,
  },
  button: {
    height: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 28,
  },
  buttonText: {
    color: "#ffffff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
});
