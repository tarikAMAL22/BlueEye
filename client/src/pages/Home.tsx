import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { getLoginUrl } from "@/const";
import { Camera, Shield, Eye, Zap, Lock } from "lucide-react";

export default function Home() {
  const { isAuthenticated, loading } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!loading && isAuthenticated) {
      navigate("/");
    }
  }, [isAuthenticated, loading, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-muted-foreground animate-pulse text-sm">Verifying credentials...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        {/* Hero Section */}
        <div className="flex-1 flex items-center justify-center p-8 relative overflow-hidden">
          {/* Animated background grid */}
          <div
            className="absolute inset-0 opacity-10"
            style={{
              backgroundImage: "linear-gradient(#00F5FF 1px, transparent 1px), linear-gradient(90deg, #00F5FF 1px, transparent 1px)",
              backgroundSize: "50px 50px",
            }}
          />
          {/* Radial glow */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(0,245,255,0.06) 0%, transparent 70%)",
            }}
          />

          <div className="relative z-10 w-full max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            {/* Left: Branding */}
            <div>
              <div className="flex items-center gap-3 mb-8">
                <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center">
                  <Eye className="w-6 h-6 text-primary" />
                </div>
                <span className="text-2xl font-bold tracking-tight text-primary">BlueEye</span>
              </div>

              <h1 className="text-5xl font-extrabold leading-tight mb-4">
                Real-time{" "}
                <span className="text-primary">AI Surveillance</span>{" "}
                Platform
              </h1>
              <p className="text-muted-foreground text-lg mb-8 leading-relaxed">
                Monitor security cameras, detect faces in real-time, manage access zones, and receive instant alerts — all from a single dashboard.
              </p>

              <Button
                onClick={() => (window.location.href = getLoginUrl())}
                size="lg"
                className="bg-primary text-primary-foreground hover:bg-primary/80 px-8 py-6 text-base font-semibold shadow-lg shadow-primary/20 transition-all hover:shadow-xl hover:shadow-primary/30 hover:scale-105"
              >
                <Lock className="w-4 h-4 mr-2" />
                Sign In Securely
              </Button>
            </div>

            {/* Right: Feature cards */}
            <div className="grid grid-cols-1 gap-4">
              {[
                { icon: Camera, title: "Multi-Camera RTSP", desc: "Connect unlimited IP cameras via RTSP, with WebRTC real-time viewing directly in the browser." },
                { icon: Shield, title: "Zone Access Control", desc: "Define security zones with configurable threat levels and per-person access rules." },
                { icon: Eye, title: "Live Detection Alerts", desc: "Computer vision detects faces and dispatches alerts with confidence scores in under a second." },
                { icon: Zap, title: "Instant Notifications", desc: "Acknowledge, escalate or dismiss alerts. Every event is logged for audit and export." },
              ].map(({ icon: Icon, title, desc }) => (
                <div
                  key={title}
                  className="p-4 rounded-lg border border-border/50 bg-card/40 backdrop-blur hover:border-primary/40 hover:bg-card/60 transition-all group"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
                      <Icon className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <p className="font-semibold text-sm mb-1">{title}</p>
                      <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border/30 py-4 px-8 flex justify-between items-center">
          <span className="text-xs text-muted-foreground">BlueEye Security Platform</span>
          <span className="text-xs text-muted-foreground">Protected by end-to-end encryption</span>
        </div>
      </div>
    );
  }

  return null;
}
