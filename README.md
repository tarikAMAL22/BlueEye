# BlueEye - Real-time Facial Recognition Security Platform

A production-ready dark cyberpunk-themed security dashboard for real-time facial recognition, camera management, zone control, and intelligent alerting.

## Features

### Dashboard Home
- Real-time KPI cards: Total Cameras, Active Zones, Recognized Faces Today, Unknown Detections, Active Alerts
- Live sparkline charts showing activity trends and system health
- Recent activity feed with latest detection events

### Camera Management (Admin Only)
- Full CRUD operations for security cameras
- Fields: Name, IP/RTSP URL, Location, Zone Assignment, Status (Online/Offline/Maintenance)
- Table view with status badges and inline edit/delete actions
- Last-seen timestamp tracking

### Zone Management (Admin Only)
- Create and manage security zones with threat levels (Low/Medium/High/Critical)
- Assign cameras to zones
- Configure per-zone access rules
- View assigned cameras per zone
- Threat level color-coding across the platform

### Live Alerts Feed
- Auto-refreshing detection events (5-second polling)
- Face thumbnail, person name/Unknown, confidence score, camera, zone, timestamp
- Color-coded by threat level
- Click any alert to open full-screen detail modal
- Manual refresh and auto-refresh toggle

### Alert Detail Modal
- Full-screen overlay with best-frame snapshot
- Matched identity card or "Unknown" fallback
- Confidence gauge visualization
- Camera metadata and zone information
- Event timeline
- Action buttons: Acknowledge, Escalate, Dismiss

### Event Log / History
- Paginated table of all recognition events
- Columns: Timestamp, Camera, Zone, Person, Confidence, Threat Level, Type
- Search by person ID, camera ID, or zone ID
- Threat level filtering via color-coding
- CSV export functionality
- Sortable columns

### Person Registry (Admin Only)
- Add known individuals with name, role, and photo URL
- Table view showing photo, name, role, zone access, activity history
- Edit and delete persons
- View zone access permissions per person
- Activity history tracking

### System Settings (Admin Only)
- Platform name configuration
- Alert threshold settings (minimum confidence to trigger)
- Notification preferences (email, push)
- Event log retention policy (days)
- User management: View and manage user roles

## Architecture

### Tech Stack
- **Frontend**: React 19, Tailwind CSS 4, Recharts, shadcn/ui
- **Backend**: Node.js, Express 4, tRPC 11
- **Database**: MySQL/TiDB with Drizzle ORM
- **Authentication**: Manus OAuth

### Database Schema
- `users` - User accounts with role-based access control
- `cameras` - Security camera configurations
- `zones` - Security zones with threat levels
- `persons` - Known individuals in the registry
- `alerts` - Real-time detection alerts
- `events` - Historical recognition events
- `settings` - System configuration
- `access_rules` - Per-zone access permissions

## Role-Based Access Control

### Admin Role
- Full access to all pages and features
- Can create, edit, delete cameras, zones, and persons
- Can manage system settings and user roles
- Can view all alerts and event logs

### Regular User Role
- Access to Dashboard, Live Alerts Feed, and Event Log only
- View-only access to detection events
- Cannot access Camera/Zone/Person management or Settings
- Cannot modify any system configuration

## Setup Instructions

### Prerequisites
- Node.js 22.13.0+
- MySQL/TiDB database
- Manus OAuth credentials

### Installation

1. **Install dependencies**
   ```bash
   pnpm install
   ```

2. **Set up environment variables**
   - `DATABASE_URL`: MySQL connection string
   - `JWT_SECRET`: Session signing secret
   - `VITE_APP_ID`: Manus OAuth application ID
   - `OAUTH_SERVER_URL`: Manus OAuth backend URL
   - `VITE_OAUTH_PORTAL_URL`: Manus login portal URL
   - `BUILT_IN_FORGE_API_URL`: Manus API URL
   - `BUILT_IN_FORGE_API_KEY`: Manus API key

3. **Generate and apply database migrations**
   ```bash
   pnpm drizzle-kit generate
   pnpm drizzle-kit migrate
   ```

4. **Start development server**
   ```bash
   pnpm dev
   ```

5. **Run tests**
   ```bash
   pnpm test
   ```

## API Procedures

All procedures are accessed via tRPC under `/api/trpc` endpoint.

### Dashboard
- `dashboard.stats` - Get KPI statistics (protected)

### Cameras (Admin Only)
- `cameras.list` - List all cameras
- `cameras.getById` - Get camera by ID
- `cameras.create` - Create new camera
- `cameras.update` - Update camera details
- `cameras.delete` - Delete camera

### Zones (Admin Only)
- `zones.list` - List all zones
- `zones.getById` - Get zone by ID
- `zones.create` - Create new zone
- `zones.update` - Update zone details
- `zones.delete` - Delete zone

### Persons (Admin Only)
- `persons.list` - List all persons
- `persons.getById` - Get person by ID
- `persons.create` - Add person to registry
- `persons.update` - Update person details
- `persons.delete` - Remove person from registry

### Alerts (Protected)
- `alerts.list` - Get active alerts (limit: number)
- `alerts.updateStatus` - Update alert status (acknowledged/escalated/dismissed)

### Events (Protected)
- `events.list` - Get event history (limit, offset)

### Settings (Admin Only)
- `settings.get` - Get system settings
- `settings.update` - Update system settings

### Authentication
- `auth.me` - Get current user info (public)
- `auth.logout` - Logout current user (public)

## Styling & Theme

### Dark Cyberpunk Aesthetic
- **Background**: Deep navy (#0A0E1A)
- **Primary Accent**: Neon cyan (#00F5FF)
- **Secondary Accent**: Neon magenta (#FF00AA)
- **Text**: Light gray on dark background
- **Data Values**: Monospace font (JetBrains Mono)
- **Cards**: Glowing borders with subtle animations
- **Status Indicators**: Animated pulse effects

### Threat Level Color-Coding
- **Low**: Green (#10B981)
- **Medium**: Yellow (#F59E0B)
- **High**: Orange (#EF4444)
- **Critical**: Red (#DC2626)

## Testing

### Run All Tests
```bash
pnpm test
```

### Test Coverage
- 43 tests covering:
  - Authentication and authorization
  - Role-based access control (admin vs user)
  - All CRUD procedures
  - Alert management
  - Event log queries
  - Settings management
  - Dashboard statistics

### Test Files
- `server/auth.logout.test.ts` - Authentication tests
- `server/cameras.test.ts` - Access control tests
- `server/procedures.test.ts` - Comprehensive procedure tests

## Deployment

### Build for Production
```bash
pnpm build
```

### Start Production Server
```bash
pnpm start
```

### Environment Variables for Production
Ensure all required environment variables are set in your production environment before starting the server.

## User Guide

### For Administrators
1. **Dashboard**: Monitor real-time statistics and system health
2. **Camera Management**: Add cameras, configure RTSP URLs, assign to zones
3. **Zone Management**: Create security zones, set threat levels, manage access rules
4. **Person Registry**: Add known individuals, manage access permissions
5. **System Settings**: Configure alert thresholds, notification preferences, retention policies
6. **Live Alerts**: Monitor real-time detections and take action (acknowledge/escalate/dismiss)
7. **Event Log**: Review historical events, search, filter, and export data

### For Regular Users
1. **Dashboard**: View real-time statistics and system overview
2. **Live Alerts Feed**: Monitor active detections and view alert details
3. **Event Log**: Search and filter historical events, export data
4. **Alert Details**: Click any alert to view full details including best-frame snapshot and confidence gauge

## Performance Considerations

- **Live Alerts**: Auto-refresh polling every 5 seconds (configurable)
- **Pagination**: Event log uses 50 items per page
- **Database Indexes**: Ensure proper indexing on frequently queried columns (timestamp, status, personId)
- **Real-time Updates**: Consider WebSocket implementation for production-scale deployments

## Security

- **Authentication**: Manus OAuth integration
- **Authorization**: Role-based access control enforced on both frontend and backend
- **Session Management**: Secure HTTP-only cookies
- **API Security**: tRPC procedures with middleware-based access control
- **Data Protection**: All sensitive data transmitted over HTTPS

## Troubleshooting

### Database Connection Issues
- Verify `DATABASE_URL` environment variable
- Check database credentials and network connectivity
- Ensure database server is running and accessible

### OAuth Login Issues
- Verify `VITE_APP_ID` and `OAUTH_SERVER_URL` are correct
- Check that redirect URLs match OAuth configuration
- Ensure cookies are enabled in browser

### Alert Updates Not Refreshing
- Check browser console for errors
- Verify backend API is responding
- Try manual refresh button in Live Alerts Feed

## License

MIT

## Support

For issues or questions, please contact the development team.
