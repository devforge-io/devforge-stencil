/**
 * /tools/feature-requests/projects/:id: a project's dashboard. Thin wrapper
 * around the shared dashboard logic, which /project/:id mounts as well.
 */

import { useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { actOnProjectDashboard, loadProjectDashboard, type DashboardData } from "~/lib/feature-requests/dashboard.server";
import { SIGN_IN_PATH, SIGN_OUT_PATH } from "~/lib/account/paths";
import { ProjectDashboardView, type DashboardActionData } from "~/components/tools/feature-requests/project-dashboard";
import { TOOL_PATH } from "~/components/tools/feature-requests/shell";

export function meta({ data }: { data?: { project?: { name: string } } }) {
  return [{ title: `${data?.project?.name ?? "Project"} · Feature requests · Devforge` }, { name: "robots", content: "noindex" }];
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  return loadProjectDashboard(request, params.id ?? "", SIGN_IN_PATH);
}

export async function action({ request, params }: ActionFunctionArgs) {
  return actOnProjectDashboard(request, params.id ?? "", SIGN_IN_PATH, `${TOOL_PATH}/projects`);
}

export default function ProjectDashboard() {
  const data = useLoaderData<typeof loader>() as DashboardData;
  const actionData = (useActionData() ?? {}) as DashboardActionData;
  const busy = useNavigation().state === "submitting";
  return (
    <ProjectDashboardView
      data={data}
      actionData={actionData}
      busy={busy}
      base={`${TOOL_PATH}/projects/${data.project.id}`}
      listHref={`${TOOL_PATH}/projects`}
      listLabel="Your projects"
      signOutAction={SIGN_OUT_PATH}
      signOutNext={TOOL_PATH}
    />
  );
}
