import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Check, Loader2, MessageCircle, Sparkles, Send } from "lucide-react";

interface ChecklistData {
  waConnected: boolean;
  aiTriedAt: string | null;
  healthScore: number;
}

type Tone = "formal" | "santai" | "profesional";

const TONES: { key: Tone; label: string; hint: string }[] = [
  { key: "formal", label: "Formal", hint: "Sopan & resmi" },
  { key: "santai", label: "Santai", hint: "Ramah & akrab" },
  { key: "profesional", label: "Profesional", hint: "Hangat tapi rapi" },
];

async function postJson(url: string, body: object) {
  const r = await fetch(url, {
    method: url.includes("ai-profile") ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

export function FirstRunWizard() {
  const qc = useQueryClient();
  const { data } = useQuery<ChecklistData>({
    queryKey: ["onboarding-checklist"],
    queryFn: () =>
      fetch("/api/onboarding/checklist", { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 15_000,
  });

  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [stepTouched, setStepTouched] = useState(false);

  // Form (step 2)
  const [businessDescription, setBusinessDescription] = useState("");
  const [aiTone, setAiTone] = useState<Tone>("profesional");
  const [operatingHours, setOperatingHours] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileErr, setProfileErr] = useState("");

  // Sandbox (step 3)
  const [sandboxMsg, setSandboxMsg] = useState("Halo, apakah masih buka? Saya mau tanya produk.");
  const [sandboxReply, setSandboxReply] = useState<string | null>(null);
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [sandboxErr, setSandboxErr] = useState("");

  // Derive a sensible starting step from server state, until the user navigates.
  useEffect(() => {
    if (stepTouched || !data) return;
    setStep(data.waConnected ? 2 : 1);
  }, [data, stepTouched]);

  const complete = useMemo(
    () => !!data && data.waConnected && !!data.aiTriedAt,
    [data]
  );
  if (!data || complete || dismissed) return null;

  const go = (s: 1 | 2 | 3) => { setStepTouched(true); setStep(s); };

  async function saveProfile() {
    setSavingProfile(true);
    setProfileErr("");
    try {
      const { ok, data: d } = await postJson("/api/onboarding/ai-profile", {
        businessDescription, aiTone, operatingHours,
      });
      if (!ok) { setProfileErr(d?.error || "Gagal menyimpan profil."); return; }
      go(3);
    } catch { setProfileErr("Terjadi kesalahan."); }
    finally { setSavingProfile(false); }
  }

  async function runSandbox() {
    if (!sandboxMsg.trim()) return;
    setSandboxLoading(true);
    setSandboxErr("");
    setSandboxReply(null);
    try {
      const { ok, data: d } = await postJson("/api/onboarding/ai-sandbox", { message: sandboxMsg });
      if (!ok) { setSandboxErr(d?.error || "Gagal menjalankan AI."); return; }
      setSandboxReply(d.reply ?? "");
      qc.invalidateQueries({ queryKey: ["onboarding-checklist"] });
    } catch { setSandboxErr("Terjadi kesalahan."); }
    finally { setSandboxLoading(false); }
  }

  function finish() {
    qc.invalidateQueries({ queryKey: ["onboarding-checklist"] });
    setDismissed(true);
  }

  return (
    <div className="rounded-xl border border-primary/20 bg-gradient-to-br from-primary/5 to-primary/10 p-5 shadow-sm" data-testid="first-run-wizard">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-foreground flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Mulai dalam 3 langkah
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Sampai AI-mu benar-benar membalas — kurang dari 2 menit.
          </p>
        </div>
        <button onClick={finish} className="text-xs text-muted-foreground hover:text-foreground">
          Lewati
        </button>
      </div>

      {/* Stepper */}
      <div className="mb-5 flex items-center gap-2">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex-1 flex items-center gap-2">
            <button
              onClick={() => go(s as 1 | 2 | 3)}
              className={`h-7 w-7 rounded-full text-xs font-semibold flex items-center justify-center transition ${
                step === s ? "bg-primary text-primary-foreground" :
                step > s ? "bg-primary/15 text-primary" : "bg-card border border-border text-muted-foreground"
              }`}
            >
              {step > s ? <Check className="h-3.5 w-3.5" /> : s}
            </button>
            {s < 3 && <div className={`h-0.5 flex-1 rounded ${step > s ? "bg-primary/40" : "bg-primary/15"}`} />}
          </div>
        ))}
      </div>

      {/* Step 1 — Connect WhatsApp */}
      {step === 1 && (
        <div className="space-y-3">
          <h4 className="font-medium text-foreground flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-green-600" /> Hubungkan WhatsApp
          </h4>
          {data.waConnected ? (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 flex items-center gap-2 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900">
              <Check className="h-4 w-4" /> WhatsApp sudah terhubung.
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Scan QR di menu Channels untuk menyambungkan nomor WhatsApp bisnismu.
            </p>
          )}
          <div className="flex gap-2">
            {!data.waConnected && (
              <Link href="/channels" className="inline-flex h-10 items-center rounded-lg bg-green-600 px-4 text-sm font-semibold text-white hover:bg-green-700">
                Hubungkan WhatsApp
              </Link>
            )}
            <button onClick={() => go(2)} className="inline-flex h-10 items-center rounded-lg border border-border bg-background px-4 text-sm font-semibold text-foreground hover:bg-muted">
              {data.waConnected ? "Lanjut" : "Lewati dulu"}
            </button>
          </div>
        </div>
      )}

      {/* Step 2 — AI-feeding profile */}
      {step === 2 && (
        <div className="space-y-3">
          <h4 className="font-medium text-foreground">Beri makan AI-mu</h4>
          <p className="text-xs text-muted-foreground -mt-1">Singkat saja — ini yang menentukan cara AI membalas.</p>
          <div>
            <label className="text-xs font-semibold text-foreground">Bisnismu jual apa?</label>
            <textarea
              value={businessDescription}
              onChange={(e) => setBusinessDescription(e.target.value)}
              rows={2}
              placeholder="Mis. Toko kopi specialty, jual biji kopi & alat seduh, terima grosir."
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-foreground">Nada bicara AI</label>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {TONES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setAiTone(t.key)}
                  className={`rounded-lg border px-2 py-2 text-left transition ${
                    aiTone === t.key ? "border-primary bg-primary/10" : "border-border bg-background hover:border-primary/40"
                  }`}
                >
                  <div className="text-sm font-semibold text-foreground">{t.label}</div>
                  <div className="text-[11px] text-muted-foreground">{t.hint}</div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-foreground">Jam operasional (opsional)</label>
            <input
              value={operatingHours}
              onChange={(e) => setOperatingHours(e.target.value)}
              placeholder="Senin–Jumat 09.00–17.00"
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
            />
          </div>
          {profileErr && <div className="text-xs text-destructive">{profileErr}</div>}
          <div className="flex gap-2">
            <button onClick={() => go(1)} className="h-10 rounded-lg border border-border bg-background px-4 text-sm font-semibold text-muted-foreground hover:bg-muted">Kembali</button>
            <button
              onClick={saveProfile}
              disabled={savingProfile || !businessDescription.trim()}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {savingProfile && <Loader2 className="h-4 w-4 animate-spin" />} Simpan & coba AI
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — Sandbox */}
      {step === 3 && (
        <div className="space-y-3">
          <h4 className="font-medium text-foreground flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Coba AI-mu sekarang
          </h4>
          <p className="text-xs text-muted-foreground -mt-1">
            Ketik seperti customer. AI membalas pakai profil di atas — tidak ada pesan terkirim ke WhatsApp.
          </p>
          <div className="flex gap-2">
            <input
              value={sandboxMsg}
              onChange={(e) => setSandboxMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") runSandbox(); }}
              placeholder="Tulis pesan customer…"
              className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
            />
            <button
              onClick={runSandbox}
              disabled={sandboxLoading || !sandboxMsg.trim()}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {sandboxLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Coba
            </button>
          </div>
          {sandboxErr && <div className="text-xs text-destructive">{sandboxErr}</div>}
          {sandboxReply != null && (
            <div className="rounded-lg border border-primary/20 bg-card p-3" data-testid="sandbox-reply">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-primary mb-1">Balasan AI</div>
              <div className="text-sm text-foreground whitespace-pre-wrap">{sandboxReply}</div>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => go(2)} className="h-10 rounded-lg border border-border bg-background px-4 text-sm font-semibold text-muted-foreground hover:bg-muted">Ubah profil</button>
            <button onClick={finish} className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
              Selesai
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
