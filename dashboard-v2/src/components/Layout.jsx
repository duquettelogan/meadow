import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import MobileNav from "./MobileNav";
import MobileHeader from "./MobileHeader";

export default function Layout() {
  return (
    <div className="flex min-h-screen" style={{background: '#ffffff'}}>
      <Sidebar />
      <main className="flex-1 min-w-0">
        <MobileHeader />
        <div className="px-4 sm:px-6 lg:px-10 py-6 lg:py-8 pb-24 lg:pb-8 max-w-5xl">
          <Outlet />
        </div>
      </main>
      <MobileNav />
    </div>
  );
}