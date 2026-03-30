import { Link } from "react-router-dom";

export default function MobileHeader() {
  return (
    <header className="lg:hidden flex items-center gap-2.5 px-4 py-3.5 border-b border-border bg-white">
      <Link to="/" className="flex items-center">
        <img
          src="https://media.base44.com/images/public/69c7442c6719753dcba83a7e/c4886cf3b_DQsecLogoFinalFiles-01.png"
          alt="DQSec Meadow"
          className="h-8 w-auto object-contain"
        />
      </Link>
    </header>
  );
}