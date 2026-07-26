import { redirect } from "next/navigation";

// /settings itself shows nothing -- it lands on the one section every
// admin can see, whatever their role.
export default function SettingsIndexPage() {
  redirect("/settings/account");
}
