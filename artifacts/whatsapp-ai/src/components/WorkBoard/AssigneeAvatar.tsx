// Small reusable assignee avatar: shows the real profile photo when present,
// falling back to a coloured initial. Used on Kanban cards (and anywhere an
// assignee avatar appears). The photo URL comes live from users.profilePhotoUrl
// and changes filename on each upload, so there is no stale-cache problem.
interface AssigneeAvatarProps {
  url?: string | null;
  name?: string | null;
  email?: string | null;
  className?: string;
}

export default function AssigneeAvatar({ url, name, email, className }: AssigneeAvatarProps) {
  const initial = (name ?? email ?? "?").trim().charAt(0).toUpperCase() || "?";
  const title = name ?? email ?? "";
  if (url) {
    return (
      <img
        src={url}
        alt={name ?? email ?? "Foto"}
        title={title}
        className={`w-5 h-5 rounded-full object-cover border border-card ${className ?? ""}`}
      />
    );
  }
  return (
    <div
      title={title}
      className={`w-5 h-5 rounded-full bg-primary/20 border border-card flex items-center justify-center text-[9px] font-bold ${className ?? ""}`}
    >
      {initial}
    </div>
  );
}
