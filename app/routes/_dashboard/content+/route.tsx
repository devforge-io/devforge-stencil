import { Outlet } from "react-router";

export default function ContentLayout() {
  return (
    <div className="px-6 py-8">
      <Outlet />
    </div>
  );
}
