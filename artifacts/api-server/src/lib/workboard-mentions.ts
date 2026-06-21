// Pure helper: extract mentioned user ids from a comment body.
// Mentions are encoded as @[<userId>] tokens inserted by the client when the
// author picks someone from the mention dropdown. Free-text "@name" that
// doesn't match the token form is NOT treated as a mention (names are unsafe
// keys — they can collide or change). Returns unique ids in order of first
// appearance. The server still re-filters these ids to board members, so a
// hand-typed @[5] for a non-member is dropped at the route.
export function parseMentionIds(body: string): number[] {
  const re = /@\[(\d+)\]/g;
  const seen = new Set<number>();
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const id = Number(m[1]);
    if (Number.isInteger(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
