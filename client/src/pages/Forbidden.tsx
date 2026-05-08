import { ShieldOff } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";

export default function Forbidden() {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="text-center max-w-md">
        <div className="flex justify-center mb-6">
          <div className="w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center border border-destructive/30">
            <ShieldOff className="w-10 h-10 text-destructive" />
          </div>
        </div>
        <h1 className="text-4xl font-bold text-destructive mb-2">403</h1>
        <h2 className="text-xl font-semibold mb-3">Access Denied</h2>
        <p className="text-muted-foreground mb-8">
          You don't have permission to access this page. Administrator privileges are required.
        </p>
        <Button
          onClick={() => navigate("/")}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          Return to Dashboard
        </Button>
      </div>
    </div>
  );
}
