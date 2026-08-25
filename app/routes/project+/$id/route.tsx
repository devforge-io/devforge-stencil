/**
 * /project/:id: the owner-facing dashboard for one project, matched by the
 * signed-in email (or account id). Same shared dashboard as the tools area.
 */

import { useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { actOnProjectDashboard, loadProjectDashboard, type DashboardData } from "~/lib/feature-requests/dashboard.server";
import { ProjectDashboardView, type DashboardActionData } from "~/components/tools/feature-requests/project-dashboard";

export function meta({ data }: { data?: { project?: { name: string } } }) {
  return [{ title: `${data?.project?.name ?? "Project"} · Devforge` }, { name: "robots", content: "noindex" }];
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  return loadProjectDashboard(request, params.id ?? "", "/project");
}

export async function action({ request, params }: ActionFunctionArgs) {
  return actOnProjectDashboard(request, params.id ?? "", "/project", "/project");
}

export default function OwnerProjectDashboard() {
  const data = useLoaderData<typeof loader>() as DashboardData;
  const actionData = (useActionData() ?? {}) as DashboardActionData;
  const busy = useNavigation().state === "submitting";
  return (
    <ProjectDashboardView
      data={data}
      actionData={actionData}
      busy={busy}
      base={`/project/${data.project.id}`}
      listHref="/project"
      listLabel="Your projects"
      signOutAction="/project"
    />
  );
}
