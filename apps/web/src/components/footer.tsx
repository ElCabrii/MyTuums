import { Link } from "@tanstack/react-router";

export function Footer() {
  return (
    <footer className="w-full border-t bg-background py-6 md:py-8 mt-auto">
      <div className="w-full flex flex-col md:flex-row items-center justify-between gap-4 px-4 sm:px-8 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <img src="/mytuums.svg" alt="MyTuums Logo" className="h-5 w-auto" />
          <span className="font-semibold text-foreground">MyTuums</span>
          <span>© {new Date().getFullYear()} MyTuums Inc. All rights reserved.</span>
        </div>
        <div className="flex flex-wrap items-center gap-4 sm:gap-6">
          <Link to="/" className="hover:underline hover:text-foreground">
            Home
          </Link>
          <Link to="/discover" className="hover:underline hover:text-foreground">
            Discover
          </Link>
          <a href="#" className="hover:underline hover:text-foreground">
            Privacy Policy
          </a>
          <a href="#" className="hover:underline hover:text-foreground">
            Terms of Service
          </a>
        </div>
      </div>
    </footer>
  );
}
