import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Check, Loader2, MessageCircle, Sparkles, Send, Wand2, ArrowLeft, ShieldCheck } from "lucide-react";

interface ChecklistData {
  waConnected: boolean;
  aiTriedAt: string | null;
  healthScore: number;
}

type Tone = "mirror" | "warm" | "formal";
type Emoji = "sedikit" | "minimal" | "bebas";
type ReplyLanguage = "follow" | "id";
type SelfIntro = "netral" | "admin" | "named";

interface WizardAnswers {
  businessName: string;
  businessDesc: string;
  flagshipProduct: string;
  orderFlow: string;
  operatingHours: string;
  tone: Tone;
  addressTerm: string;
  emoji: Emoji;
  replyLanguage: ReplyLanguage;
  selfIntro: SelfIntro;
  selfName: string;
  forbidden: string;
}

const EMPTY_ANSWERS: WizardAnswers = {
  businessName: "",
  businessDesc: "",
  flagshipProduct: "",
  orderFlow: "",
  operatingHours: "",
  tone: "mirror",
  addressTerm: "kak",
  emoji: "sedikit",
  replyLanguage: "follow",
  selfIntro: "netral",
  selfName: "",
  forbidden: "",
};

const TONE_OPTS: { key: Tone; label: string; hint: string }[] = [
  { key: "mirror", label: "Ikuti customer", hint: "Santai kalau dia santai, rapi kalau formal" },
  { key: "warm", label: "Hangat", hint: "Selalu ramah & akrab" },
  { key: "formal", label: "Rapi", hint: "Sopan & profesional" },
];
const EMOJI_OPTS: { key: Emoji; label: string }[] = [
  { key: "sedikit", label: "Sedikit (1–2)" },
  { key: "minimal", label: "Hampir tidak ada" },
  { key: "bebas", label: "Bebas" },
];
const LANG_OPTS: { key: ReplyLanguage; label: string }[] = [
  { key: "follow", label: "Ikuti customer" },
  { key: "id", label: "Selalu Indonesia" },
];
const INTRO_OPTS: { key: SelfIntro; label: string }[] = [
  { key: "netral", label: "Netral" },
  { key: "admin", label: "Sebagai admin/CS" },
  { key: "named", label: "Pakai nama" },
];

const inputCls =
  "mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring";
const labelCls = "text-xs font-semibold text-foreground";

async function api(url: string, body: object, method: "POST" | "PUT" = "POST") {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({} as Record<string, unknown>)) };
}

// Small reusable segmented control for enum choices.
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { key: T; label: string; hint?: string }[];
}) {
  return (
    <div className={`mt-1 grid gap-2 ${options.length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`rounded-lg border px-2 py-2 text-left transition ${
            value === o.key ? "border-primary bg-primary/10" : "border-border bg-background hover:border-primary/40"
          }`}
        >
          <div className="text-sm font-semibold text-foreground">{o.label}</div>
          {o.hint && <div className="text-[11px] text-muted-foreground">{o.hint}</div>}
        </button>
      ))}
    </div>
  );
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

  // Step 2 — wizard answers + sub-phases.
  const [sub, setSub] = useState<"business" | "style" | "review">("business");
  const [a, setA] = useState<WizardAnswers>(EMPTY_ANSWERS);
  const set = <K extends keyof WizardAnswers>(k: K, v: WizardAnswers[K]) => setA((p) => ({ ...p, [k]: v }));

  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [refining, setRefining] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [step2Err, setStep2Err] = useState("");

  // Sandbox (step 3)
  const [sandboxMsg, setSandboxMsg] = useState("Halo, apakah masih buka? Saya mau tanya produk.");
  const [sandboxReply, setSandboxReply] = useState<string | null>(null);
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [sandboxErr, setSandboxErr] = useState("");

  // Prefill prior wizard answers (so re-opening keeps inputs).
  useEffect(() => {
    let active = true;
    fetch("/api/onboarding/ai-wizard", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && d?.answers && typeof d.answers === "object") {
          setA((p) => ({ ...p, ...d.answers }));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Derive a sensible starting step from server state, until the user navigates.
  useEffect(() => {
    if (stepTouched || !data) return;
    setStep(data.waConnected ? 2 : 1);
  }, [data, stepTouched]);

  const complete = useMemo(() => !!data && data.waConnected && !!data.aiTriedAt, [data]);
  if (!data || complete || dismissed) return null;

  const go = (s: 1 | 2 | 3) => { setStepTouched(true); setStep(s); };

  async function generate() {
    if (!a.businessName.trim() || !a.businessDesc.trim()) {
      setStep2Err("Nama bisnis dan deskripsi wajib diisi.");
      return;
    }
    setGenerating(true);
    setStep2Err("");
    try {
      const { ok, data: d } = await api("/api/onboarding/ai-wizard/generate", a);
      if (!ok) { setStep2Err((d?.error as string) || "Gagal membuat prompt."); return; }
      setPrompt((d.systemPrompt as string) ?? "");
      setSub("review");
    } catch { setStep2Err("Terjadi kesalahan."); }
    finally { setGenerating(false); }
  }

  async function refine() {
    if (!prompt.trim()) return;
    setRefining(true);
    setStep2Err("");
    try {
      const { ok, data: d } = await api("/api/onboarding/ai-wizard/refine", { persona: prompt });
      if (!ok) { setStep2Err((d?.error as string) || "AI sedang tidak tersedia. Template tetap bisa dipakai."); return; }
      setPrompt((d.refined as string) ?? prompt);
    } catch { setStep2Err("Terjadi kesalahan."); }
    finally { setRefining(false); }
  }

  async function save(overwrite: boolean) {
    setSaving(true);
    setStep2Err("");
    try {
      const { ok, status, data: d } = await api("/api/onboarding/ai-wizard/save", {
        answers: a,
        systemPrompt: prompt,
        overwrite,
      });
      if (status === 409 && d?.reason === "needs_confirmation") {
        setConfirmOverwrite(true);
        return;
      }
      if (!ok) { setStep2Err((d?.error as string) || "Gagal menyimpan."); return; }
      setConfirmOverwrite(false);
      qc.invalidateQueries({ queryKey: ["onboarding-checklist"] });
      go(3);
    } catch { setStep2Err("Terjadi kesalahan."); }
    finally { setSaving(false); }
  }

  async function runSandbox() {
    if (!sandboxMsg.trim()) return;
    setSandboxLoading(true);
    setSandboxErr("");
    setSandboxReply(null);
    try {
      const { ok, data: d } = await api("/api/onboarding/ai-sandbox", { message: sandboxMsg });
      if (!ok) { setSandboxErr((d?.error as string) || "Gagal menjalankan AI."); return; }
      setSandboxReply((d.reply as string) ?? "");
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

      {/* Step 2 — AI Setup Wizard */}
      {step === 2 && (
        <div className="space-y-3">
          <h4 className="font-medium text-foreground">Beri makan AI-mu</h4>

          {/* Sub-step 2a — Tentang bisnis */}
          {sub === "business" && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground -mt-1">Tentang bisnismu — ini konteks inti AI.</p>
              <div>
                <label className={labelCls}>Nama bisnismu?</label>
                <input value={a.businessName} onChange={(e) => set("businessName", e.target.value)} placeholder="Mis. Kopi Senja" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Bisnismu jual apa?</label>
                <textarea value={a.businessDesc} onChange={(e) => set("businessDesc", e.target.value)} rows={2} placeholder="Mis. Toko kopi specialty, jual biji kopi & alat seduh, terima grosir." className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Produk/layanan yang paling sering ditanya? <span className="text-muted-foreground font-normal">(opsional)</span></label>
                <input value={a.flagshipProduct} onChange={(e) => set("flagshipProduct", e.target.value)} placeholder="AI jadikan konteks prioritas, tapi tetap cek semua produk" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Cara order & pembayaran? <span className="text-muted-foreground font-normal">(opsional)</span></label>
                <input value={a.orderFlow} onChange={(e) => set("orderFlow", e.target.value)} placeholder="Transfer BCA, konfirmasi ke admin." className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Jam operasional? <span className="text-muted-foreground font-normal">(opsional)</span></label>
                <input value={a.operatingHours} onChange={(e) => set("operatingHours", e.target.value)} placeholder="Senin–Jumat 09.00–17.00" className={inputCls} />
              </div>
              {step2Err && <div className="text-xs text-destructive">{step2Err}</div>}
              <div className="flex gap-2">
                <button onClick={() => go(1)} className="h-10 rounded-lg border border-border bg-background px-4 text-sm font-semibold text-muted-foreground hover:bg-muted">Kembali</button>
                <button
                  onClick={() => { if (!a.businessName.trim() || !a.businessDesc.trim()) { setStep2Err("Nama bisnis dan deskripsi wajib diisi."); return; } setStep2Err(""); setSub("style"); }}
                  className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
                >
                  Lanjut
                </button>
              </div>
            </div>
          )}

          {/* Sub-step 2b — Cara AI ngobrol */}
          {sub === "style" && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground -mt-1">Cara AI ngobrol dengan customer.</p>
              <div>
                <label className={labelCls}>Nada bicara AI</label>
                <Segmented value={a.tone} onChange={(v) => set("tone", v)} options={TONE_OPTS} />
              </div>
              <div>
                <label className={labelCls}>Panggil customer dengan?</label>
                <input value={a.addressTerm} onChange={(e) => set("addressTerm", e.target.value)} placeholder="kak" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Emoji</label>
                <Segmented value={a.emoji} onChange={(v) => set("emoji", v)} options={EMOJI_OPTS} />
              </div>
              <div>
                <label className={labelCls}>Bahasa balasan</label>
                <Segmented value={a.replyLanguage} onChange={(v) => set("replyLanguage", v)} options={LANG_OPTS} />
              </div>
              <div>
                <label className={labelCls}>AI memperkenalkan diri sebagai?</label>
                <Segmented value={a.selfIntro} onChange={(v) => set("selfIntro", v)} options={INTRO_OPTS} />
                {a.selfIntro === "named" && (
                  <input value={a.selfName} onChange={(e) => set("selfName", e.target.value)} placeholder="Nama AI (mis. Sasa)" className={inputCls} />
                )}
              </div>
              <div>
                <label className={labelCls}>Ada yang TIDAK boleh AI lakukan? <span className="text-muted-foreground font-normal">(opsional)</span></label>
                <input value={a.forbidden} onChange={(e) => set("forbidden", e.target.value)} placeholder="Mis. jangan janji diskon, jangan sebut stok." className={inputCls} />
              </div>
              {step2Err && <div className="text-xs text-destructive">{step2Err}</div>}
              <div className="flex gap-2">
                <button onClick={() => setSub("business")} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border bg-background px-4 text-sm font-semibold text-muted-foreground hover:bg-muted">
                  <ArrowLeft className="h-4 w-4" /> Kembali
                </button>
                <button
                  onClick={generate}
                  disabled={generating}
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                >
                  {generating && <Loader2 className="h-4 w-4 animate-spin" />} Generate Prompt
                </button>
              </div>
            </div>
          )}

          {/* Sub-step review — edit + approve */}
          {sub === "review" && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground -mt-1">
                Ini kepribadian AI-mu. Edit bebas, atau perhalus dengan AI. Aturan keamanan (harga, stok, dll.) otomatis ditambahkan dan tidak perlu ditulis di sini.
              </p>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={10}
                className={`${inputCls} font-mono text-xs leading-relaxed`}
                data-testid="textarea-wizard-prompt"
              />
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Aturan keamanan bawaan selalu aktif (tidak bisa dihapus).
              </div>
              {step2Err && <div className="text-xs text-destructive">{step2Err}</div>}

              {confirmOverwrite ? (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                  <div className="text-sm text-foreground">
                    Prompt AI-mu di AI Studio sudah pernah diubah manual. Timpa dengan hasil wizard ini?
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setConfirmOverwrite(false)} className="h-9 rounded-lg border border-border bg-background px-3 text-sm font-semibold text-muted-foreground hover:bg-muted">Batal</button>
                    <button onClick={() => save(true)} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                      {saving && <Loader2 className="h-4 w-4 animate-spin" />} Ya, timpa
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => setSub("style")} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border bg-background px-4 text-sm font-semibold text-muted-foreground hover:bg-muted">
                    <ArrowLeft className="h-4 w-4" /> Ubah jawaban
                  </button>
                  <button
                    onClick={refine}
                    disabled={refining || !prompt.trim()}
                    className="inline-flex h-10 items-center gap-2 rounded-lg border border-primary/30 bg-card px-4 text-sm font-semibold text-primary hover:bg-primary/5 disabled:opacity-60"
                  >
                    {refining ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Perhalus dengan AI
                  </button>
                  <button
                    onClick={() => save(false)}
                    disabled={saving || !prompt.trim()}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                  >
                    {saving && <Loader2 className="h-4 w-4 animate-spin" />} Setuju & simpan
                  </button>
                </div>
              )}
            </div>
          )}
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
            <button onClick={() => { setStep(2); setSub("review"); }} className="h-10 rounded-lg border border-border bg-background px-4 text-sm font-semibold text-muted-foreground hover:bg-muted">Ubah profil</button>
            <button onClick={finish} className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
              Selesai
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
