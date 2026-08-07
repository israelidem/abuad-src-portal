/**
 * Route definitions.
 *
 * Replaces the previous single 1,100-line component that switched views
 * with useState. Real routes mean the back button, deep links, bookmarks
 * and refresh all behave as users expect.
 *
 * Pages are lazy-loaded so the initial bundle stays small — the admin
 * dashboard pulls in Recharts, which no student ever needs to download.
 */

import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Layout from './components/Layout.jsx';
import { FullPageSpinner } from './components/Spinner.jsx';
import {
  RequireAuth,
  RequireStaff,
  RedirectIfAuthenticated,
} from './components/RouteGuards.jsx';

const Home = lazy(() => import('./pages/Home.jsx'));
const Login = lazy(() => import('./pages/Login.jsx'));
const Signup = lazy(() => import('./pages/Signup.jsx'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword.jsx'));
const ResetPassword = lazy(() => import('./pages/ResetPassword.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const TicketList = lazy(() => import('./pages/TicketList.jsx'));
const TicketDetail = lazy(() => import('./pages/TicketDetail.jsx'));
const NewTicket = lazy(() => import('./pages/NewTicket.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard.jsx'));
const NotFound = lazy(() => import('./pages/NotFound.jsx'));
const Forbidden = lazy(() => import('./pages/Forbidden.jsx'));

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <Suspense fallback={<FullPageSpinner />}>
              <Routes>
                <Route element={<Layout />}>
                  {/* Public */}
                  <Route index element={<Home />} />
                  <Route path="tickets" element={<TicketList />} />
                  <Route path="tickets/:id" element={<TicketDetail />} />

                  <Route
                    path="login"
                    element={
                      <RedirectIfAuthenticated>
                        <Login />
                      </RedirectIfAuthenticated>
                    }
                  />
                  <Route
                    path="signup"
                    element={
                      <RedirectIfAuthenticated>
                        <Signup />
                      </RedirectIfAuthenticated>
                    }
                  />
                  <Route path="forgot-password" element={<ForgotPassword />} />
                  {/* Reached from the emailed link — stays open by design */}
                  <Route path="reset-password" element={<ResetPassword />} />

                  {/* Signed in */}
                  <Route element={<RequireAuth />}>
                    <Route path="dashboard" element={<Dashboard />} />
                    <Route path="tickets/new" element={<NewTicket />} />
                    <Route path="profile" element={<Profile />} />
                  </Route>

                  {/* REP and ADMIN */}
                  <Route element={<RequireStaff />}>
                    <Route path="admin" element={<AdminDashboard />} />
                  </Route>

                  <Route path="403" element={<Forbidden />} />
                  <Route path="404" element={<NotFound />} />
                  <Route path="*" element={<Navigate to="/404" replace />} />
                </Route>
              </Routes>
            </Suspense>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
