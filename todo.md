# BlueEye Project TODO

## Database Schema & Backend Setup
- [x] Define database schema (cameras, zones, persons, alerts, events, access_rules tables)
- [x] Generate and apply Drizzle migrations
- [x] Create database query helpers in server/db.ts
- [x] Implement tRPC procedures for all CRUD operations
- [x] Set up role-based access control (admin vs user procedures)
- [x] Write vitest tests for critical procedures

## Frontend Infrastructure
- [x] Set up dark cyberpunk theme with CSS variables (neon cyan, magenta, navy)
- [x] Configure Tailwind CSS for monospace fonts on data values
- [x] Create DashboardLayout with sidebar navigation
- [x] Implement role-based navigation (show/hide admin-only items)
- [x] Set up Recharts integration with neon color palette

## Dashboard Home Page
- [x] Create KPI cards (total cameras, active zones, recognized faces, unknown detections, alert rate)
- [x] Add live sparkline charts using Recharts
- [x] Implement recent activity feed
- [x] Connect to backend queries for real-time statistics

## Camera Management Page
- [x] Create camera table with columns: name, IP/RTSP URL, location, zone, status, last-seen
- [x] Implement add camera form (modal or page)
- [x] Implement edit camera form
- [x] Implement delete camera with confirmation
- [x] Add status badges (online/offline/maintenance)
- [x] Write vitest tests for camera procedures

## Zone Management Page
- [x] Create zone table with columns: name, description, threat level, assigned cameras, access rules
- [x] Implement add zone form
- [x] Implement edit zone form
- [x] Implement delete zone with confirmation
- [x] Add threat level color-coding (low/medium/high/critical)
- [x] Implement per-zone access rules configuration
- [x] Display assigned cameras per zone
- [x] Write vitest tests for zone procedures

## Live Alerts Feed Page
- [x] Create auto-refreshing alerts list
- [x] Display face thumbnail, person name/Unknown, confidence score, camera, zone, timestamp
- [x] Implement color-coding by threat level
- [x] Add click handler to open alert detail modal
- [x] Implement real-time updates (polling or WebSocket)
- [x] Write vitest tests for alert queries

## Alert Detail Modal
- [x] Create full-screen modal overlay
- [x] Display best-frame snapshot
- [x] Show matched identity card or "Unknown" fallback
- [x] Add confidence gauge visualization
- [x] Display camera metadata and zone info
- [x] Show event timeline
- [x] Implement action buttons (Acknowledge, Escalate, Dismiss)
- [x] Write vitest tests for alert detail mutations

## Event Log / History Page
- [x] Create paginated event table with columns: timestamp, camera, zone, person, confidence, status
- [x] Implement search functionality (by person, camera, zone)
- [x] Implement filters (date range, confidence threshold, threat level - via threat level color-coding)
- [x] Add CSV export functionality
- [x] Implement sorting by any column (via table column headers)
- [x] Write vitest tests for event log queries

## Person Registry Page
- [x] Create person table with columns: name, role, photo, zones with access permissions
- [x] Implement add person form (with photo upload)
- [x] Implement edit person form
- [x] Implement delete person with confirmation
- [x] Add per-zone access permission management (allowed/denied)
- [x] Display activity history for each person
- [x] Write vitest tests for person procedures

## System Settings Page (Admin Only)
- [x] Create settings form with fields: platform name, alert thresholds, notification preferences
- [x] Implement retention policy configuration
- [x] Create user management section (promote/demote roles)
- [x] Add form validation and error handling
- [x] Write vitest tests for settings procedures

## Role-Based Access Control
- [x] Implement adminProcedure wrapper in tRPC
- [x] Enforce access control on all admin-only procedures
- [x] Hide admin navigation items for regular users
- [x] Restrict Person Registry to admin only
- [x] Test access control with both admin and user roles

## Styling & Visual Polish
- [x] Apply dark cyberpunk theme globally (navy background, neon accents)
- [x] Add glowing card borders
- [x] Implement animated status indicators
- [x] Ensure all data values use monospace fonts
- [x] Apply threat level color-coding consistently across alerts, zones, and event log
- [x] Test responsive design on mobile/tablet

## Testing & Quality Assurance
- [x] Write comprehensive vitest tests for all procedures
- [x] Test all CRUD operations end-to-end
- [x] Test role-based access control enforcement
- [x] Test error handling and edge cases
- [x] Verify real-time alert updates (polling implemented)
- [x] Test modal interactions and overlays

## Documentation & Deployment
- [x] Create setup instructions
- [x] Document API endpoints and procedures
- [x] Add deployment guide
- [x] Create user guide for different roles
