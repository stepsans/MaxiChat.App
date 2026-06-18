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
import { requestLoginOtp, resendLoginOtp } from "@/lib/api";
import { useColors } from "@/hooks/useColors";

type Step = "email" | "otp";

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const emailValid = /\S+@\S+\.\S+/.test(email.trim());

  // Step 1 — email: ask the backend to email a one-time code.
  const onRequestOtp = async () => {
    if (submitting) return;
    setError(null);
    setInfo(null);
    if (!emailValid) {
      setError("Masukkan email yang valid.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await requestLoginOtp(email.trim());
      setDevOtp(res?.devOtp ?? null);
      setStep("otp");
      setInfo(`Kode dikirim ke ${email.trim()}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal mengirim kode.");
    } finally {
      setSubmitting(false);
    }
  };

  // Step 2 — otp: verify the code and establish the session.
  const onVerify = async () => {
    if (submitting) return;
    setError(null);
    if (otp.trim().length < 4) {
      setError("Masukkan kode OTP yang dikirim ke email Anda.");
      return;
    }
    setSubmitting(true);
    try {
      await signIn(email.trim(), otp.trim());
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Gagal masuk.";
      setError(
        /401|invalid|unauthorized|salah/i.test(msg) ? "Kode OTP salah atau kedaluwarsa." : msg,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const onResend = async () => {
    if (submitting) return;
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      const res = await resendLoginOtp(email.trim());
      setDevOtp(res?.devOtp ?? null);
      setInfo("Kode baru telah dikirim.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal mengirim ulang kode.");
    } finally {
      setSubmitting(false);
    }
  };

  const backToEmail = () => {
    setStep("email");
    setOtp("");
    setError(null);
    setInfo(null);
    setDevOtp(null);
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
          <Text style={[styles.title, { color: colors.foreground }]}>MaxiChat</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {step === "email"
              ? "Masuk dengan kode sekali pakai (OTP)"
              : "Masukkan kode yang dikirim ke email Anda"}
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
                  opacity: step === "otp" ? 0.6 : 1,
                },
              ]}
              placeholder="nama@perusahaan.com"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
              editable={!submitting && step === "email"}
              onSubmitEditing={onRequestOtp}
              returnKeyType="next"
            />

            {step === "otp" ? (
              <>
                <Text style={[styles.label, { color: colors.foreground }]}>
                  Kode OTP
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    styles.otpInput,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      color: colors.foreground,
                    },
                  ]}
                  placeholder="••••••"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="number-pad"
                  autoFocus
                  maxLength={6}
                  value={otp}
                  onChangeText={(t) => setOtp(t.replace(/[^0-9]/g, ""))}
                  editable={!submitting}
                  onSubmitEditing={onVerify}
                  returnKeyType="go"
                />
                {devOtp ? (
                  <Text style={[styles.dev, { color: colors.mutedForeground }]}>
                    Kode dev: {devOtp}
                  </Text>
                ) : null}
              </>
            ) : null}

            {info ? (
              <Text style={[styles.info, { color: colors.mutedForeground }]}>{info}</Text>
            ) : null}
            {error ? (
              <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
            ) : null}

            <TouchableOpacity
              style={[
                styles.button,
                { backgroundColor: colors.primary },
                submitting && { opacity: 0.7 },
              ]}
              onPress={step === "email" ? onRequestOtp : onVerify}
              disabled={submitting}
              activeOpacity={0.85}
            >
              {submitting ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.buttonText}>
                  {step === "email" ? "Kirim Kode" : "Masuk"}
                </Text>
              )}
            </TouchableOpacity>

            {step === "otp" ? (
              <View style={styles.otpActions}>
                <TouchableOpacity onPress={onResend} disabled={submitting}>
                  <Text style={[styles.linkAction, { color: colors.primary }]}>
                    Kirim ulang kode
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={backToEmail} disabled={submitting}>
                  <Text style={[styles.linkAction, { color: colors.mutedForeground }]}>
                    Ganti email
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
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
  otpInput: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 22,
    letterSpacing: 8,
    textAlign: "center",
  },
  dev: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginTop: 8,
  },
  info: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    marginTop: 14,
  },
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
  otpActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 20,
  },
  linkAction: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
});
