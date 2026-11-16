// Its own module, imported first by main.tsx, because imports are hoisted:
// a call written at the top of main.tsx would run only after every shared
// module had been evaluated, and a screen that reads the platform while it
// loads would already have seen the default, "windows". Modules evaluate in
// import order, so this one runs before any of them.
import { setDesktopPlatform } from "@shared/lib/desktop-platform";

setDesktopPlatform("linux");
