import MemoryObservabilityCard from "../components/MemoryObservabilityCard";
import type { useDashboardData } from "./use-dashboard-data";
import { DashboardPlanQuotaSection } from "./dashboard-plan-quota-section";
import {
  DashboardEffortCapPanel,
  DashboardInjectionPanel,
  DashboardMaintenancePanel,
  DashboardSidecarPanels,
} from "./dashboard-overview-sections";
import { MediaSettingsCard } from "./media-settings-card";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardOverviewPanels(props: Dash) {
  return (
    <>
      <DashboardEffortCapPanel apiBase={props.apiBase} d={props} />
      <div className="dash-overview-tools">
        <DashboardInjectionPanel apiBase={props.apiBase} d={props} />
        <DashboardMaintenancePanel d={props} />
      </div>
      <DashboardSidecarPanels d={props} />
      <MediaSettingsCard apiBase={props.apiBase} />
      <DashboardPlanQuotaSection apiBase={props.apiBase} />
      <MemoryObservabilityCard apiBase={props.apiBase} />
    </>
  );
}
