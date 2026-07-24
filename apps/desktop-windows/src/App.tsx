import { useEffect, useState } from "react";
import { getTokens } from "./lib/session";
import { Login } from "./screens/Login";
import { Register } from "./screens/Register";
import { Dashboard } from "./screens/Dashboard";

type Screen = "loading" | "login" | "register" | "dashboard";

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");

  useEffect(() => {
    getTokens().then((tokens) => setScreen(tokens ? "dashboard" : "login"));
  }, []);

  if (screen === "loading") {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading...</div>;
  }
  if (screen === "login") {
    return <Login onSuccess={() => setScreen("dashboard")} onGoRegister={() => setScreen("register")} />;
  }
  if (screen === "register") {
    return <Register onSuccess={() => setScreen("dashboard")} onGoLogin={() => setScreen("login")} />;
  }
  return <Dashboard onLoggedOut={() => setScreen("login")} />;
}
