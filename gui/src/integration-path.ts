/** Shorten familiar home-directory paths for compact, non-sensitive display. */
export function homeDisplayPath(path: string): string {
  const unixHome = path.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (unixHome) return `~${unixHome[1] ?? ""}`;

  const windowsHome = path.match(/^[a-z]:[\\/]Users[\\/][^\\/]+([\\/].*)?$/i);
  if (windowsHome) return `~${windowsHome[1] ?? ""}`;

  return path;
}
