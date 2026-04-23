import { Outlet } from "react-router";

export default function AuthLayout() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Stencil</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Git-backed CMS
          </p>
        </div>
        <Outlet />
      </div>
    </div>
  );
}
