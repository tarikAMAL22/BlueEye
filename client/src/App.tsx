import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import Forbidden from "@/pages/Forbidden";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";
import Dashboard from "./pages/Dashboard";
import Home from "./pages/Home";
import CameraManagement from "./pages/CameraManagement";
import ZoneManagement from "./pages/ZoneManagement";
import LiveAlertsFeed from "./pages/LiveAlertsFeed";
import EventLog from "./pages/EventLog";
import PersonRegistry from "./pages/PersonRegistry";
import PersonDetails from "./pages/PersonDetails";
import SystemSettings from "./pages/SystemSettings";
import BlacklistManagement from "./pages/BlacklistManagement";
import MotionDetections from "./pages/MotionDetections";
import AlertDetails from "./pages/AlertDetails";
import MovementDetails from "./pages/MovementDetails";
import ManageUnknownReview from "./pages/ManageUnknownReview";
import { useAuth } from "./_core/hooks/useAuth";

function Router() {
  const { user, isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-medium text-muted-foreground animate-pulse uppercase tracking-widest">
            Initializing BlueEye...
          </p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Switch>
        <Route path={"/"} component={Home} />
        <Route path={"/404"} component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  const isAdmin = user?.role === "admin";

  return (
    <DashboardLayout>
      <Switch>
        <Route path={"/"} component={Dashboard} />
        <Route path={"/alerts"} component={LiveAlertsFeed} />
        <Route path={"/alerts/:id"} component={AlertDetails} />
        <Route path={"/movements"} component={MotionDetections} />
        <Route path={"/movements/:id"} component={MovementDetails} />
        <Route path={"/events"} component={EventLog} />
        
        {/* Admin-only routes */}
        <Route path={"/persons"}>{isAdmin ? <PersonRegistry /> : <Forbidden />}</Route>
        <Route path={"/persons/review"}>{isAdmin ? <ManageUnknownReview /> : <Forbidden />}</Route>
        <Route path={"/persons/:id"}>{isAdmin ? <PersonDetails /> : <Forbidden />}</Route>
        <Route path={"/cameras"}>{isAdmin ? <CameraManagement /> : <Forbidden />}</Route>
        <Route path={"/zones"}>{isAdmin ? <ZoneManagement /> : <Forbidden />}</Route>
        <Route path={"/blacklist"}>{isAdmin ? <BlacklistManagement /> : <Forbidden />}</Route>
        <Route path={"/settings"}>{isAdmin ? <SystemSettings /> : <Forbidden />}</Route>
        
        <Route path={"/404"} component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </DashboardLayout>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="dark"
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
