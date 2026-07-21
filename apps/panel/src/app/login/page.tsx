import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Logo } from "@/components/brand/logo";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect("/overview");

  return (
    <div className="glow-backdrop flex min-h-svh items-center justify-center overflow-hidden p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <Logo className="scale-110" />
        <LoginForm />
        <p className="text-center text-xs text-muted-foreground">
          NeoConnect control plane &middot; internal use only
        </p>
      </div>
    </div>
  );
}
