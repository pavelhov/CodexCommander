/** Sidebar footer link to the project repository. */
import { IconGithub } from "../icons";
import { useT } from "../i18n/shared";

const REPO_URL = "https://github.com/pavelhov/CodexCommander";

export function SidebarGithubRow() {
  const t = useT();

  return (
    <div className="sidebar-github-row">
      <a className="sidebar-link sidebar-github-link" href={REPO_URL} target="_blank" rel="noreferrer">
        <IconGithub /> {t("common.github")}
      </a>
    </div>
  );
}
