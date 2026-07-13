import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, Legend } from 'recharts';
import { MessageSquare, CheckCircle, Clock, PlusCircle, X, Upload, Shield, User, FileText, MapPin, Flag, Search, Filter, Lock, LogOut, ImageIcon, HelpCircle, Settings, Key, Sparkles, Award, Mail, ShieldCheck } from 'lucide-react';

const FOREST_GREEN = '#006633';
const MAX_YELLOW = '#FAF92A';

export default function App() {
  // Authentication & Session States
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [authError, setAuthError] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [isOtpStage, setIsOtpStage] = useState(false); 
  const [otpCode, setOtpCode] = useState('');          
  const [currentUser, setCurrentUser] = useState(null);

  // Layout View State: 'dashboard' or 'profile'
  const [activeTab, setActiveTab] = useState('dashboard');

  // Interactive System Tutorial State
  const [tutorialStep, setTutorialStep] = useState(-1);

  // Unified Form State for Logins, Signups, Password Resets
  const [authForm, setAuthForm] = useState({ 
    fullName: '',
    username: '', 
    matricNumber: '',
    password: '', 
    email: '',
    role: 'student' 
  });

  // Core Functional States
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [urgencyFilter, setUrgencyFilter] = useState('');
  const [liveTickets, setLiveTickets] = useState([]);
  const [isLoadingLive, setIsLoadingLive] = useState(false);

  // Form State Controlled Elements
  const [formData, setFormData] = useState({
    name: '',
    faculty: '',
    category: '',
    location: '',
    description: '',
    urgency: 'Medium',
    image: ''
  });

  // Fetch live entries on mount or when auth state updates
  useEffect(() => {
    if (isAuthenticated) {
      fetchLiveTickets();
    }
  }, [isAuthenticated]);

  const fetchLiveTickets = async () => {
    setIsLoadingLive(true);
    try {
      const response = await fetch('http://localhost:5000/api/feedback');
      const data = await response.json();
      setLiveTickets(data);
    } catch (error) {
      console.error('Error fetching backend tickets:', error);
    } finally {
      setIsLoadingLive(false);
    }
  };

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      setFormData(prev => ({ ...prev, image: reader.result }));
    };
    reader.readAsDataURL(file);
  };

  const handleAvatarChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      setCurrentUser(prev => ({ ...prev, avatar: reader.result }));
    };
    reader.readAsDataURL(file);
  };

  const handleProfileUpdate = (e) => {
    e.preventDefault();
    alert('Dashboard parameters adjusted successfully!');
    setActiveTab('dashboard');
  };

  // Connected Database Authentication Handler
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');

    if (isForgotPassword) {
      alert(`Password recovery sequence initialized for ${authForm.username}. Check your student webmail for verification links.`);
      setIsForgotPassword(false);
      return;
    }

    const endpoint = isSignUp ? 'signup' : 'login';
    
    const payload = isSignUp 
      ? { 
          fullName: authForm.fullName, 
          username: authForm.username, 
          matricNumber: authForm.matricNumber, 
          password: authForm.password, 
          email: authForm.email, 
          role: 'student' 
        }
      : { 
          username: authForm.username, 
          password: authForm.password, 
          role: authForm.role 
        };
    
    try {
      const response = await fetch(`http://localhost:5000/api/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const data = await response.json();

      if (!response.ok) {
        // CATCH UNVERIFIED USER RETURN STATUS:
        if (data.error && (data.error.toLowerCase().includes('verify') || data.error.toLowerCase().includes('otp'))) {
          alert('This profile is awaiting activation. Redirecting to verification console.');
          
          setAuthForm(prev => ({
            ...prev,
            email: data.email || prev.email || prev.username 
          }));

          setIsSignUp(false);
          setIsOtpStage(true); 
          return;
        }
        
        setAuthError(data.error || 'Authentication action failed.');
        return;
      }

      if (isSignUp) {
        alert('Account initialization details submitted! Please check your email inbox for your verification code.');
        setIsSignUp(false);
        setIsOtpStage(true); 
      } else {
        setIsAuthenticated(true);
        setIsAdminMode(data.role === 'admin');
        setCurrentUser({ 
          name: data.fullName || data.username, 
          role: data.role,
          matricNumber: data.matricNumber || 'N/A',
          faculty: 'Faculty of Law',
          avatar: '' 
        });
        setFormData(prev => ({ ...prev, name: data.fullName || data.username }));
        setTutorialStep(0);
      }
    } catch (error) {
      setAuthError('Could not establish connection to the backend authentication server.');
    }
  };

  // Submission handler for the OTP Token Verification screen
  const handleOtpSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');

    try {
      const response = await fetch('http://localhost:5000/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          email: authForm.email, 
          otp: otpCode 
        })
      });

      const data = await response.json();

      if (!response.ok) {
        setAuthError(data.error || 'Invalid or expired OTP code entered.');
        return;
      }

      alert('OTP Code Confirmed! Your account is now fully verified. Please sign in.');
      setIsOtpStage(false);
      setOtpCode('');
      setAuthForm({ fullName: '', username: '', matricNumber: '', password: '', email: '', role: 'student' });
    } catch (error) {
      setAuthError('Could not reach verification server to validate OTP token.');
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setCurrentUser(null);
    setAuthForm({ fullName: '', username: '', matricNumber: '', password: '', email: '', role: 'student' });
    setIsSignUp(false);
    setIsForgotPassword(false);
    setIsOtpStage(false);
    setOtpCode('');
    setLiveTickets([]);
    setActiveTab('dashboard');
    setTutorialStep(-1);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const response = await fetch('http://localhost:5000/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });

      if (response.ok) {
        setFormData({ name: currentUser?.name || '', faculty: '', category: '', location: '', description: '', urgency: 'Medium', image: '' });
        setIsModalOpen(false);
        fetchLiveTickets();
      } else {
        const errorData = await response.json();
        alert(`Submission failed: ${errorData.error}`);
      }
    } catch (error) {
      console.error('Error during submission:', error);
      alert('Could not reach backend server.');
    }
  };

  const cycleLiveStatus = async (id, currentStatus, e) => {
    if (e) e.stopPropagation();
    let nextStatus = 'Pending';
    if (currentStatus === 'Pending') nextStatus = 'In Progress';
    else if (currentStatus === 'In Progress') nextStatus = 'Resolved';

    try {
      const response = await fetch(`http://localhost:5000/api/feedback/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const updated = await response.json();
      
      setLiveTickets(prev => prev.map(t => t._id === id ? updated : t));
      if (selectedTicket && selectedTicket._id === id) {
        setSelectedTicket(updated);
      }
    } catch (error) {
      console.error('Failed changing ticket status on database:', error);
    }
  };

  const getLiveChartData = () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dataMetrics = months.reduce((acc, m) => ({ 
      ...acc, 
      [m]: { reported: 0, resolved: 0 } 
    }), {});

    liveTickets.forEach(ticket => {
      const dateObj = ticket.date ? new Date(ticket.date) : new Date();
      if (!isNaN(dateObj.getTime())) {
        const monthName = months[dateObj.getMonth()];
        dataMetrics[monthName].reported += 1;
        if (ticket.status === 'Resolved') {
          dataMetrics[monthName].resolved += 1;
        }
      }
    });

    return months.map(name => ({ 
      name, 
      Reported: dataMetrics[name].reported,
      Resolved: dataMetrics[name].resolved
    }));
  };

  const displayedTickets = isAdminMode 
    ? liveTickets 
    : liveTickets.filter(t => t.name === currentUser?.name || !t.name || t.name === 'Anonymous Student');

  const totalFeedback = displayedTickets.length;
  const pendingCount = displayedTickets.filter(t => t.status === 'Pending').length;
  const inProgressCount = displayedTickets.filter(t => t.status === 'In Progress').length;
  const resolvedCount = displayedTickets.filter(t => t.status === 'Resolved').length;
  
  const resolutionRate = totalFeedback > 0 
    ? Math.round((resolvedCount / totalFeedback) * 100) 
    : 0;

  const stats = [
    { id: 1, name: 'Total Submissions', value: totalFeedback, icon: MessageSquare, color: 'text-emerald-800', bg: 'bg-emerald-50' },
    { id: 2, name: 'Awaiting Review', value: pendingCount, icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
    { id: 3, name: 'In Progress', value: inProgressCount, icon: Settings, color: 'text-blue-600', bg: 'bg-blue-50' },
    { id: 4, name: 'Issues Resolved', value: resolvedCount, icon: CheckCircle, color: 'text-emerald-600', bg: 'bg-emerald-100' },
  ];

  const filteredTickets = displayedTickets.filter(ticket => {
    const matchesSearch = 
      ticket.ticketId?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      ticket.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      ticket.location?.toLowerCase().includes(searchQuery.toLowerCase());
      
    const matchesCategory = categoryFilter === '' || ticket.category === categoryFilter;
    const matchesUrgency = urgencyFilter === '' || ticket.urgency === urgencyFilter;
    
    return matchesSearch && matchesCategory && matchesUrgency;
  });

  const tutorialSteps = [
    { title: "Welcome to ABUAD Portal", text: "Let's take a quick 4-step tour to look at your newly added system upgrades!" },
    { title: "Advanced Tracker Cards", text: "You can now view live metric counters for issues currently 'In Progress' and 'Resolved' at the top of your dashboard." },
    { title: "Interactive Profile Hub", text: "Click the profile area anytime to upload a custom profile image and modify your active account information." },
    { title: "Live Resolution Performance Charts", text: "Our integrated charting tools now graph 'Reported' versus 'Resolved' entries by month simultaneously." }
  ];

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4 font-sans">
        <div className="bg-white w-full max-w-md rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
          <div className="p-6 text-center text-white space-y-2" style={{ backgroundColor: FOREST_GREEN }}>
            <div className="h-12 w-12 rounded-xl mx-auto flex items-center justify-center text-[#FAF92A] font-bold text-xl bg-emerald-900 shadow-inner">
              SRC
            </div>
            <h2 className="text-xl font-bold tracking-tight">ABUAD Quality Feedback Portal</h2>
            <p className="text-xs opacity-85">
              {isOtpStage ? 'One-Time Password Verification' : isForgotPassword ? 'Secure Password Recovery System' : isSignUp ? 'Create a Database Student Profile' : 'Secure Portal Access & Verification Management'}
            </p>
          </div>
          
          {isOtpStage ? (
            <form className="p-6 space-y-4" onSubmit={handleOtpSubmit}>
              {authError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 font-semibold">
                  {authError}
                </div>
              )}
              <div className="p-3 bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-xl text-xs leading-relaxed text-center font-medium">
                An activation code has been routed to your digital inbox. Enter the code below to complete registration rules.
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1 text-center">Enter Verification OTP</label>
                <div className="relative">
                  <ShieldCheck className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    required
                    maxLength="10"
                    placeholder="Enter received code token"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                    className="pl-9 pr-3 py-2 w-full bg-white border border-slate-200 rounded-xl text-sm font-mono tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-[#006633]"
                  />
                </div>
              </div>
              <button
                type="submit"
                className="w-full py-2.5 text-white rounded-xl font-bold text-sm shadow-md hover:opacity-95 transition-all cursor-pointer"
                style={{ backgroundColor: FOREST_GREEN }}
              >
                Verify & Activate Account
              </button>
              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setIsOtpStage(false);
                    setAuthError('');
                  }}
                  className="text-xs font-semibold text-slate-600 hover:text-[#006633] underline cursor-pointer"
                >
                  Back to Sign In
                </button>
              </div>
            </form>
          ) : (
            <form className="p-6 space-y-4" onSubmit={handleAuthSubmit}>
              {authError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 font-semibold">
                  {authError}
                </div>
              )}

              {isForgotPassword ? (
                <div className="space-y-4">
                  <div className="p-3 bg-amber-50 text-amber-800 border border-amber-200 rounded-xl text-xs leading-relaxed">
                    Enter your verified user account identifier or student registration matriculation number below to fetch matching recovery access paths.
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Username or Matric Number</label>
                    <div className="relative">
                      <Key className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                      <input
                        type="text"
                        required
                        placeholder="e.g., john_doe or 26/LAW01/000"
                        value={authForm.username}
                        onChange={(e) => setAuthForm({ ...authForm, username: e.target.value })}
                        className="pl-9 pr-3 py-2 w-full bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#006633]"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    className="w-full py-2.5 text-white rounded-xl font-bold text-sm shadow-md hover:opacity-95 transition-all cursor-pointer"
                    style={{ backgroundColor: FOREST_GREEN }}
                  >
                    Send Recovery Request
                  </button>
                  <div className="text-center pt-1">
                    <button
                      type="button"
                      onClick={() => setIsForgotPassword(false)}
                      className="text-xs font-semibold text-slate-600 hover:text-[#006633] underline cursor-pointer"
                    >
                      Return to Portal Sign In
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {!isSignUp && (
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Access Scope</label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setAuthForm({ ...authForm, role: 'student' })}
                          className={`py-2 text-xs font-bold rounded-xl border transition-all cursor-pointer ${
                            authForm.role === 'student' ? 'border-[#006633] bg-emerald-50 text-[#006633]' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                          }`}
                        >
                          <User size={14} className="inline mr-1" /> Student
                        </button>
                        <button
                          type="button"
                          onClick={() => setAuthForm({ ...authForm, role: 'admin' })}
                          className={`py-2 text-xs font-bold rounded-xl border transition-all cursor-pointer ${
                            authForm.role === 'admin' ? 'border-[#006633] bg-emerald-50 text-[#006633]' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                          }`}
                        >
                          <Shield size={14} className="inline mr-1" /> Representative
                        </button>
                      </div>
                    </div>
                  )}

                  {isSignUp && (
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Full Name</label>
                      <div className="relative">
                        <User className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                        <input
                          type="text"
                          required
                          placeholder="e.g., John Doe"
                          value={authForm.fullName}
                          onChange={(e) => setAuthForm({ ...authForm, fullName: e.target.value })}
                          className="pl-9 pr-3 py-2 w-full bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#006633]"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">
                      {isSignUp ? 'Preferred Username' : authForm.role === 'admin' ? 'Admin Username' : 'Preferred Username'}
                    </label>
                    <div className="relative">
                      <User className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                      <input
                        type="text"
                        required
                        placeholder={authForm.role === 'admin' && !isSignUp ? 'e.g., admin' : 'e.g., john_doe'}
                        value={authForm.username}
                        onChange={(e) => setAuthForm({ ...authForm, username: e.target.value })}
                        className="pl-9 pr-3 py-2 w-full bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#006633]"
                      />
                    </div>
                  </div>

                  {isSignUp && (
                    <>
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Matric Number</label>
                        <div className="relative">
                          <FileText className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                          <input
                            type="text"
                            required
                            placeholder="e.g., 26/LAW01/000"
                            value={authForm.matricNumber}
                            onChange={(e) => setAuthForm({ ...authForm, matricNumber: e.target.value })}
                            className="pl-9 pr-3 py-2 w-full bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#006633]"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Email Address</label>
                        <div className="relative">
                          <Mail className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                          <input
                            type="email"
                            required
                            placeholder="e.g., name@domain.com"
                            value={authForm.email}
                            onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })}
                            className="pl-9 pr-3 py-2 w-full bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#006633]"
                          />
                        </div>
                      </div>
                    </>
                  )}

                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Security Password</label>
                      {!isSignUp && (
                        <button
                          type="button"
                          onClick={() => setIsForgotPassword(true)}
                          className="text-xs font-semibold text-emerald-700 hover:underline cursor-pointer"
                        >
                          Forgot Password?
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                      <input
                        type="password"
                        required
                        placeholder="••••••••"
                        value={authForm.password}
                        onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })}
                        className="pl-9 pr-3 py-2 w-full bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#006633]"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full py-2.5 text-white rounded-xl font-bold text-sm shadow-md hover:opacity-95 transition-all cursor-pointer mt-2"
                    style={{ backgroundColor: FOREST_GREEN }}
                  >
                    {isSignUp ? 'Register Profile' : 'Sign In to System'}
                  </button>

                  <div className="text-center pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setIsSignUp(!isSignUp);
                        setAuthError('');
                        setAuthForm({ fullName: '', username: '', matricNumber: '', password: '', email: '', role: 'student' });
                      }}
                      className="text-xs font-semibold text-slate-600 hover:text-[#006633] underline transition-colors cursor-pointer"
                    >
                      {isSignUp ? 'Already registered? Log in here' : 'New student? Register a profile here'}
                    </button>
                  </div>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans relative pb-12">
      {/* Header */}
      <header className="bg-white border-b-4 border-[#FAF92A] sticky top-0 z-40 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl flex items-center justify-center text-[#FAF92A] font-bold text-lg shadow-md" style={{ backgroundColor: FOREST_GREEN }}>
            SRC
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-950">ABUAD Student Portal</h1>
            <p className="text-xs font-semibold text-[#006633]">{isAdminMode ? 'Admin / Representative Dashboard (Live)' : 'Student Feedback Center (Live)'}</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div 
            onClick={() => !isAdminMode && setActiveTab(activeTab === 'profile' ? 'dashboard' : 'profile')}
            className={`flex items-center gap-2 border-r border-slate-200 pr-4 cursor-pointer transition-all p-1 rounded-xl hover:bg-slate-50 ${activeTab === 'profile' ? 'bg-emerald-50 ring-1 ring-emerald-300' : ''}`}
            title={isAdminMode ? "Admin Profile" : "Open Student Settings Dashboard"}
          >
            {currentUser?.avatar ? (
              <img 
                src={currentUser.avatar} 
                alt="Profile Avatar" 
                className="h-8 w-8 rounded-full object-cover border-2 border-emerald-600 shadow-sm"
              />
            ) : (
              <div className="h-8 w-8 rounded-full bg-emerald-50 border-2 border-slate-200 text-slate-600 flex items-center justify-center">
                {isAdminMode ? <Shield size={16} /> : <User size={16} />}
              </div>
            )}
            <div className="text-left hidden sm:block">
              <p className="text-xs font-bold text-slate-800 leading-none">{currentUser?.name}</p>
              {!isAdminMode && <p className="text-[10px] text-emerald-700 font-medium mt-0.5">Edit Profile</p>}
            </div>
          </div>

          <button
            onClick={() => setTutorialStep(0)}
            className="p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
            title="Launch Interactive Website Walkthrough"
          >
            <HelpCircle size={18} />
          </button>

          {!isAdminMode && activeTab === 'dashboard' && (
            <button 
              onClick={() => setIsModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-white shadow-md hover:opacity-90 transition-all cursor-pointer"
              style={{ backgroundColor: FOREST_GREEN }}
            >
              <PlusCircle size={16} style={{ color: MAX_YELLOW }} />
              New Feedback
            </button>
          )}

          <button 
            onClick={handleLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-700 rounded-xl text-xs font-bold hover:bg-red-100 transition-colors cursor-pointer"
            title="Sign Out"
          >
            <LogOut size={14} />
            <span className="hidden md:inline">Sign Out</span>
          </button>
        </div>
      </header>

      {activeTab === 'profile' && !isAdminMode ? (
        <main className="max-w-3xl mx-auto p-6 mt-6">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="p-6 text-white flex items-center gap-4" style={{ backgroundColor: FOREST_GREEN }}>
              <div className="relative">
                {currentUser?.avatar ? (
                  <img src={currentUser.avatar} alt="Profile" className="h-20 w-20 rounded-full border-4 border-white/20 object-cover" />
                ) : (
                  <div className="h-20 w-20 rounded-full bg-emerald-900 border-4 border-white/20 flex items-center justify-center text-white"><User size={36} /></div>
                )}
                <label className="absolute bottom-0 right-0 p-1.5 bg-white text-slate-800 rounded-full shadow border border-slate-200 cursor-pointer hover:scale-105 transition-transform">
                  <Upload size={12} />
                  <input type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
                </label>
              </div>
              <div>
                <h2 className="text-xl font-bold">{currentUser?.name}</h2>
                <p className="text-xs text-emerald-200 font-mono mt-0.5">{currentUser?.matricNumber}</p>
              </div>
            </div>

            <form onSubmit={handleProfileUpdate} className="p-6 space-y-4">
              <h3 className="font-bold text-slate-900 border-b pb-2 text-sm uppercase tracking-wider text-slate-400">Modify Account Metadata</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-600 uppercase mb-1">Full Legal Name</label>
                  <input 
                    type="text" 
                    value={currentUser?.name} 
                    onChange={(e) => setCurrentUser({...currentUser, name: e.target.value})}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-[#006633] outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 uppercase mb-1">Registered Faculty</label>
                  <input 
                    type="text" 
                    value={currentUser?.faculty} 
                    onChange={(e) => setCurrentUser({...currentUser, faculty: e.target.value})}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-[#006633] outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 uppercase mb-1">Student Identification Number (Matric)</label>
                <input type="text" disabled value={currentUser?.matricNumber} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-400 font-mono" />
              </div>
              
              <div className="pt-4 flex gap-3 justify-end border-t border-slate-100">
                <button type="button" onClick={() => setActiveTab('dashboard')} className="px-4 py-2 border border-slate-200 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-50">Back to Dashboard</button>
                <button type="submit" className="px-5 py-2 text-white font-bold text-sm rounded-xl shadow-md" style={{ backgroundColor: FOREST_GREEN }}>Save Changes</button>
              </div>
            </form>
          </div>
        </main>
      ) : (
        <main className="max-w-7xl mx-auto p-6 space-y-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {stats.map((stat) => {
              const Icon = stat.icon;
              return (
                <div key={stat.id} className="bg-white p-5 rounded-2xl border-l-4 border-[#006633] shadow-sm flex items-center justify-between">
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">{stat.name}</p>
                    <p className="text-2xl font-black text-slate-900">{stat.value}</p>
                  </div>
                  <div className={`p-3 rounded-xl ${stat.bg} ${stat.color}`}>
                    <Icon size={20} />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/50 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
                <div>
                  <h2 className="font-bold text-slate-900 text-lg">
                    {isAdminMode ? 'Live Database Submissions Management' : 'Track My Registered Issues'}
                  </h2>
                  <span className="text-xs text-emerald-700 font-bold bg-emerald-50 px-2 py-0.5 rounded-md inline-block mt-0.5">Connected to Local MongoDB</span>
                </div>
                
                <div className="flex flex-row items-center gap-2 max-w-full overflow-x-auto pb-1 xl:pb-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                  <div className="relative flex-shrink-0">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
                    <input 
                      type="text"
                      placeholder="Search complaints..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-8 pr-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs w-32 sm:w-36 focus:outline-none focus:ring-2 focus:ring-[#006633]"
                    />
                  </div>
                  <div className="relative flex items-center flex-shrink-0">
                    <Filter className="absolute left-2.5 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
                    <select
                      value={categoryFilter}
                      onChange={(e) => setCategoryFilter(e.target.value)}
                      className="pl-8 pr-6 py-1.5 bg-white border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-[#006633] appearance-none cursor-pointer font-medium text-slate-600"
                    >
                      <option value="">All Categories</option>
                      <option value="Academic">Academic</option>
                      <option value="ICT">ICT</option>
                      <option value="Infrastructure">Infrastructure</option>
                      <option value="Welfare">Welfare</option>
                      <option value="Administration">Administration</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div className="relative flex items-center flex-shrink-0">
                    <Filter className="absolute left-2.5 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
                    <select
                      value={urgencyFilter}
                      onChange={(e) => setUrgencyFilter(e.target.value)}
                      className="pl-8 pr-6 py-1.5 bg-white border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-[#006633] appearance-none cursor-pointer font-medium text-slate-600"
                    >
                      <option value="">All Urgency</option>
                      <option value="Low">Low</option>
                      <option value="Medium">Medium</option>
                      <option value="High">High</option>
                    </select>
                  </div>
                </div>
              </div>
              
              <div className="overflow-x-auto">
                {isLoadingLive ? (
                  <div className="p-12 text-center text-sm font-medium text-slate-400">Loading data directly from server...</div>
                ) : (
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 text-slate-400 uppercase text-xs font-semibold tracking-wider border-b border-slate-200">
                        <th className="px-4 py-3">ID</th>
                        <th className="px-4 py-3">Issue Description</th>
                        <th className="px-4 py-3">Category</th>
                        <th className="px-4 py-3">Location</th>
                        <th className="px-4 py-3">Urgency</th>
                        <th className="px-4 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {filteredTickets.map((item) => {
                        let badgeStyle = "bg-yellow-100 text-yellow-800 border border-yellow-300";
                        if (item.status === 'In Progress') badgeStyle = "bg-blue-100 text-blue-800 border border-blue-200";
                        if (item.status === 'Resolved') badgeStyle = "bg-emerald-100 text-emerald-800 border border-emerald-200";

                        return (
                          <tr 
                            key={item._id} 
                            onClick={() => setSelectedTicket(item)}
                            className="hover:bg-slate-100/80 transition-colors cursor-pointer"
                            title="Click to view complete details"
                          >
                            <td className="px-4 py-4 font-semibold text-blue-700 whitespace-nowrap">{item.ticketId}</td>
                            <td className="px-4 py-4 text-slate-700 max-w-[180px] truncate">{item.description}</td>
                            <td className="px-4 py-4 text-slate-600 font-medium whitespace-nowrap">{item.category}</td>
                            <td className="px-4 py-4 text-slate-600 max-w-[140px] truncate">{item.location}</td>
                            <td className="px-4 py-4 whitespace-nowrap">
                              <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                                item.urgency === 'High' ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700'
                              }`}>{item.urgency}</span>
                            </td>
                            <td className="px-4 py-4 whitespace-nowrap">
                              {isAdminMode ? (
                                <button
                                  onClick={(e) => cycleLiveStatus(item._id, item.status, e)}
                                  className={`px-2.5 py-1 rounded-full text-xs font-bold border cursor-pointer hover:ring-2 hover:ring-slate-400 transition-all ${badgeStyle}`}
                                  title="Click to cycle ticket status"
                                >
                                  {item.status}
                                </button>
                              ) : (
                                <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${badgeStyle}`}>
                                  {item.status}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {filteredTickets.length === 0 && !isLoadingLive && (
                  <div className="p-8 text-center text-sm text-slate-400">
                    {liveTickets.length === 0 ? 'No data present in database.' : 'No matching issues found for your active parameters.'}
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
              <div>
                <h2 className="font-bold text-slate-900 text-md uppercase tracking-wide text-slate-500">Live Resolution Analytics</h2>
                <p className="text-xs text-slate-400 mb-4">Comparison of submissions to resolved tickets</p>
              </div>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={getLiveChartData()}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="name" stroke="#94a3b8" fontSize={11} tickLine={false} />
                    <YAxis allowDecimals={false} stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Reported" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Resolved" fill={FOREST_GREEN} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {!isAdminMode && (
            <div className="bg-gradient-to-r from-emerald-800 to-[#004d26] text-white p-6 rounded-2xl shadow-lg border border-emerald-900 flex flex-col md:flex-row items-center justify-between gap-4 mt-8">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-white/10 flex items-center justify-center text-[#FAF92A]">
                  <Award size={28} />
                </div>
                <div>
                  <h3 className="text-lg font-extrabold tracking-tight">You Reported, We Resolved!</h3>
                  <p className="text-xs text-emerald-200/90 max-w-xl">Every issue uploaded helps the Student Representative Council drive measurable standard changes. Your reports build a cleaner, faster campus community infrastructure.</p>
                </div>
              </div>
              <div className="bg-white/15 px-4 py-3 rounded-xl border border-white/10 text-center min-w-[140px]">
                <p className="text-2xl font-black text-[#FAF92A]">{resolutionRate}%</p>
                <p className="text-[10px] uppercase font-bold tracking-wider text-emerald-100">Resolution Rate</p>
              </div>
            </div>
          )}
        </main>
      )}

      {tutorialStep >= 0 && tutorialStep < tutorialSteps.length && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border-2 border-emerald-600 rounded-2xl p-6 shadow-2xl max-w-sm w-full relative space-y-4 animate-in zoom-in-95">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-emerald-800 uppercase tracking-widest bg-emerald-50 px-2.5 py-1 rounded-md flex items-center gap-1">
                <Sparkles size={12} /> System Portal Tour ({tutorialStep + 1}/{tutorialSteps.length})
              </span>
              <button onClick={() => setTutorialStep(-1)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
            </div>
            <div className="space-y-1">
              <h3 className="font-extrabold text-slate-900 text-base">{tutorialSteps[tutorialStep].title}</h3>
              <p className="text-xs text-slate-500 leading-relaxed">{tutorialSteps[tutorialStep].text}</p>
            </div>
            <div className="flex justify-between items-center pt-2">
              <button 
                onClick={() => setTutorialStep(-1)} 
                className="text-xs font-semibold text-slate-400 hover:text-slate-600"
              >
                Skip Tour
              </button>
              <button
                onClick={() => setTutorialStep(tutorialStep + 1)}
                className="px-4 py-1.5 text-white text-xs font-bold rounded-lg shadow"
                style={{ backgroundColor: FOREST_GREEN }}
              >
                {tutorialStep === tutorialSteps.length - 1 ? 'Finish Tour' : 'Next Step'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-lg rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center" style={{ borderLeft: `6px solid ${FOREST_GREEN}` }}>
              <div>
                <h3 className="font-bold text-slate-900 text-lg">Student Quality Feedback Form</h3>
                <p className="text-xs text-slate-400">Logged in as: {currentUser?.name}</p>
              </div>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 cursor-pointer">
                <X size={20} />
              </button>
            </div>

            <form className="p-6 space-y-4 max-h-[75vh] overflow-y-auto" onSubmit={handleSubmit}>
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">Submitting User</label>
                <input type="text" disabled className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-500 font-medium" value={formData.name} />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">Faculty / Department *</label>
                <input type="text" required className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#006633]" placeholder="e.g., Engineering, Law" value={formData.faculty} onChange={(e) => setFormData({ ...formData, faculty: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">Issue Category *</label>
                <select required className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#006633]" value={formData.category} onChange={(e) => setFormData({ ...formData, category: e.target.value })}>
                  <option value="">Choose category...</option>
                  <option value="Academic">Academic</option>
                  <option value="ICT">ICT</option>
                  <option value="Infrastructure">Infrastructure</option>
                  <option value="Welfare">Welfare</option>
                  <option value="Administration">Administration</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">Location *</label>
                <input type="text" required className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#006633]" placeholder="Specify Hostel, Building, or Area" value={formData.location} onChange={(e) => setFormData({ ...formData, location: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">Describe the issue in Detail *</label>
                <textarea required rows="3" className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#006633]" placeholder="Explain what went wrong..." value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })}></textarea>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">Upload Photo (If Any)</label>
                <input type="file" id="feedback-image-upload" accept="image/*" className="hidden" onChange={handleImageChange} />
                <label htmlFor="feedback-image-upload" className="border-2 border-dashed border-slate-200 rounded-xl p-4 flex flex-col items-center justify-center gap-2 hover:bg-slate-50 transition-colors cursor-pointer text-slate-400 hover:text-slate-600 block min-h-[100px]">
                  {formData.image ? (
                    <div className="flex flex-col items-center gap-2">
                      <img src={formData.image} alt="Preview" className="h-20 w-auto rounded-lg object-cover shadow-sm border border-slate-200" />
                      <span className="text-xs text-emerald-600 font-semibold">Image uploaded! Click to change</span>
                    </div>
                  ) : (
                    <>
                      <Upload size={20} />
                      <span className="text-xs font-medium">Click to select files</span>
                    </>
                  )}
                </label>
              </div>
              <div className="flex gap-4 items-center">
                <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">Urgency Level:</span>
                {['Low', 'Medium', 'High'].map((level) => (
                  <label key={level} className="flex items-center gap-1.5 text-sm font-medium text-slate-600 cursor-pointer">
                    <input type="radio" name="urgency" value={level} className="text-[#006633] focus:ring-[#006633]" checked={formData.urgency === level} onChange={(e) => setFormData({ ...formData, urgency: e.target.value })} />
                    {level}
                  </label>
                ))}
              </div>
              <div className="pt-4 flex gap-3 justify-end border-t border-slate-100">
                <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 border border-slate-200 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer">Cancel</button>
                <button type="submit" className="px-5 py-2 rounded-xl text-sm font-bold text-white shadow-md hover:opacity-90 transition-all cursor-pointer" style={{ backgroundColor: FOREST_GREEN }}>Submit Feedback</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedTicket && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200 font-mono">
                  {selectedTicket.ticketId}
                </span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                  selectedTicket.urgency === 'High' ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700'
                }`}>
                  {selectedTicket.urgency} Urgency
                </span>
              </div>
              <button onClick={() => setSelectedTicket(null)} className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer">
                <X size={18} />
              </button>
            </div>

            <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto">
              <div>
                <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-2 flex items-center gap-1">
                  <User size={12} /> Submitter Information
                </h4>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex justify-between text-sm">
                  <div>
                    <p className="text-xs text-slate-400 font-medium">Name</p>
                    <p className="font-semibold text-slate-900">{selectedTicket.name || 'Anonymous Student'}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-400 font-medium">Faculty / Dept</p>
                    <p className="font-semibold text-slate-900">{selectedTicket.faculty || 'Unspecified'}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-1 flex items-center gap-1">
                    <Flag size={12} /> Category
                  </h4>
                  <p className="text-sm font-semibold text-slate-800 bg-slate-50 border border-slate-200 px-3 py-2 rounded-xl">
                    {selectedTicket.category}
                  </p>
                </div>
                <div>
                  <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-1 flex items-center gap-1">
                    <MapPin size={12} /> Location Focus
                  </h4>
                  <p className="text-sm font-semibold text-slate-800 bg-slate-50 border border-slate-200 px-3 py-2 rounded-xl truncate">
                    {selectedTicket.location}
                  </p>
                </div>
              </div>

              <div>
                <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-1 flex items-center gap-1">
                  <FileText size={12} /> Full Issue Description
                </h4>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                  {selectedTicket.description}
                </div>
              </div>

              {selectedTicket.image && (
                <div>
                  <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-2 flex items-center gap-1">
                    <ImageIcon size={12} /> Attached Photo Reference
                  </h4>
                  <div className="border border-slate-200 rounded-xl p-2 bg-slate-50 flex justify-center">
                    <img src={selectedTicket.image} alt="Attachment" className="max-h-64 w-auto rounded-lg object-contain" />
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-slate-100 flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-400 font-medium">Current Status</p>
                  <span className={`inline-block mt-1 px-3 py-1 rounded-full text-xs font-bold border ${
                    selectedTicket.status === 'Pending' ? 'bg-yellow-100 text-yellow-800 border border-yellow-300' :
                    selectedTicket.status === 'In Progress' ? 'bg-blue-100 text-blue-800 border border-blue-200' :
                    'bg-emerald-100 text-emerald-800 border border-emerald-200'
                  }`}>
                    {selectedTicket.status}
                  </span>
                </div>

                {isAdminMode && (
                  <button
                    onClick={() => cycleLiveStatus(selectedTicket._id, selectedTicket.status)}
                    className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-bold shadow hover:bg-slate-800"
                  >
                    Change Status
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}