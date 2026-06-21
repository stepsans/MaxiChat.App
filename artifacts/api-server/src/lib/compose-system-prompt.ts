const TONE_LABEL: Record<string, string> = {
  formal: "formal dan sopan",
  santai: "ramah, santai, dan akrab",
  profesional: "profesional namun hangat",
};

export function composeSystemPrompt(input: {
  businessDescription?: string | null;
  aiTone?: string | null;
  operatingHours?: string | null;
}): string {
  const tone = TONE_LABEL[input.aiTone ?? "profesional"] ?? TONE_LABEL.profesional;
  const lines: string[] = [];
  lines.push(
    `Kamu adalah asisten customer service via WhatsApp untuk bisnis ini.`
  );
  if (input.businessDescription?.trim()) {
    lines.push(`Tentang bisnis: ${input.businessDescription.trim()}`);
  }
  lines.push(`Gunakan gaya bahasa ${tone}. Jawab ringkas, jelas, dan membantu.`);
  if (input.operatingHours?.trim()) {
    lines.push(`Jam operasional: ${input.operatingHours.trim()}.`);
  }
  lines.push(
    `Jika kamu tidak tahu jawabannya, katakan jujur dan tawarkan untuk` +
      ` menghubungkan ke tim manusia. Jangan mengarang harga atau stok.`
  );
  return lines.join("\n");
}
