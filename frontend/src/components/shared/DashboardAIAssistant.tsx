'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '@/store/auth.store';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { api } from '@/services/api';

interface Message {
  sender: 'user' | 'ai';
  text: string;
  timestamp: Date;
  modelUsed?: string;
  provider?: string;
}

export function DashboardAIAssistant() {
  const { user } = useAuthStore();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Derive role properties
  const roleName = user?.role || 'staff';
  const roleDisplay: { title: string; icon: string; color: string; suggestions: string[] } = ({
    doctor: { title: 'MD Clinical Co-Pilot (Muse Spark)', icon: '🩺', color: 'from-purple-500 to-indigo-600', suggestions: ['Check dosage safe ranges', 'Review treatment protocols', 'Summarize latest guidelines'] },
    nurse: { title: 'Nursing Flow Helper (Muse Spark)', icon: '👩‍⚕️', color: 'from-blue-500 to-cyan-600', suggestions: ['Check vital ranges', 'Admission checklist', 'Draft shift handover notes'] },
    care_home_nurse: { title: 'Care Home Clinical Co-Pilot', icon: '🏡', color: 'from-teal-500 to-emerald-600', suggestions: ['Pressure ulcer protocol', 'Fall risk medication check', 'Resident shift handover'] },
    pharmacist: { title: 'Rx Dispensing Safety Co-Pilot (Muse Spark)', icon: '💊', color: 'from-emerald-500 to-green-600', suggestions: ['Verify drug interactions', 'Identify low stock alerts', 'Substitutions guide'] },
    pharmacy_admin: { title: 'PPMV & Site Pharmacy Co-Pilot (Muse Spark)', icon: '🏪', color: 'from-emerald-600 to-teal-700', suggestions: ['PCN Tier-1 OTC vs POM list', 'Verify NAFDAC ACT dosing', 'Coordinate rider delivery'] },
    medicine_store_attendant: { title: 'PPMV Counter Safety Assistant', icon: '🏪', color: 'from-emerald-600 to-teal-700', suggestions: ['PCN Tier-1 OTC vs POM list', 'Verify NAFDAC ACT dosing', 'When to escalate to doctor'] },
    admin: { title: 'Platform Command Co-Pilot (Muse Spark)', icon: '🏛️', color: 'from-indigo-600 to-purple-700', suggestions: ['Audit SLA queue metrics', 'Check facility coverage', 'Review active tickets'] },
    super_admin: { title: 'Platform Command Co-Pilot (Muse Spark)', icon: '🏛️', color: 'from-indigo-600 to-purple-700', suggestions: ['Audit SLA queue metrics', 'Check facility coverage', 'Review active tickets'] },
    lab_technician: { title: 'Lab QC Analyzer (Muse Spark)', icon: '🧪', color: 'from-amber-500 to-orange-600', suggestions: ['Verify control values', 'Check turnaround triggers', 'Flag critical values'] },
    rad_technician: { title: 'Radiology Imaging Co-Pilot', icon: '📡', color: 'from-indigo-500 to-blue-600', suggestions: ['IV contrast eGFR safety check', 'STAT critical finding protocol', 'Radiation dose optimization'] },
  } as Record<string, { title: string; icon: string; color: string; suggestions: string[] }>)[roleName] || { title: 'Docarion AI Assistant (Muse Spark)', icon: '✨', color: 'from-indigo-500 to-purple-600', suggestions: ['How to search patient record', 'Help with dashboard navigation', 'Check platform policies'] };

  // Trigger automated greeting based on role on mount
  useEffect(() => {
    const greetingText = ({
      doctor: `Hello Dr. ${user?.profile?.lastName || ''}, I am your Meta Muse Spark clinical decisions assistant. I can help suggest evidence-based management plans and check drug catalog dosages.`,
      nurse: `Hello Nurse ${user?.profile?.firstName || ''}, I am here to help you log vitals, prepare shift handovers, and track patient admissions efficiently.`,
      care_home_nurse: `Hello Nurse ${user?.profile?.firstName || ''}, I can assist with resident pressure-ulcer staging, Braden scores, and medication administration safety.`,
      pharmacist: `Welcome back to the Docarion Central Pharmacy portal. I am ready to run interaction safety checks, verify NAFDAC registration numbers, suggest stock substitutions, and coordinate with local PPMV sites.`,
      pharmacy_admin: `Welcome to the Site Pharmacy & PPMV Co-Pilot. Ask me about PCN Tier-1 OTC dispensing rules, NAFDAC verification, stock confirmation, or mobilizing a Docarion delivery rider.`,
      medicine_store_attendant: `Welcome to the PPMV Counter Co-Pilot. Ask me about PCN Tier-1 OTC dispensing rules, NAFDAC verification, or when to escalate a POM request to an on-duty doctor.`,
      admin: `Platform Command Co-Pilot active. Ask me about live SLA queue metrics, Central vs PPMV routing, or active clinical tickets.`,
      super_admin: `Platform Command Co-Pilot active. Ask me about live SLA queue metrics, Central vs PPMV routing, or active clinical tickets.`,
      lab_technician: `Laboratory assistant active. Ask me about quality control ranges, critical values notification procedures, or test panel definitions.`,
      rad_technician: `Radiology Co-Pilot active. Ask me about IV contrast screening protocols, modality positioning, or critical finding escalation.`,
    } as Record<string, string>)[roleName] || `Hi there! I am your Docarion Meta Muse Spark AI Assistant. How can I help you facilitate your clinical workflow today?`;

    setMessages([
      {
        sender: 'ai',
        text: greetingText,
        timestamp: new Date(),
        modelUsed: 'meta-muse-spark',
        provider: 'meta',
      }
    ]);
  }, [roleName, user]);

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
    }
  }, [messages, isOpen]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSend = async (textToSend?: string) => {
    const messageText = textToSend || input;
    if (!messageText.trim()) return;

    const userMessage: Message = {
      sender: 'user',
      text: messageText,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    if (!textToSend) setInput('');
    setLoading(true);

    try {
      // Authenticated call via platform API client
      const response = await api.post('/ai/chat', {
        message: `Role: ${roleName}. User query: ${messageText}`,
        role: roleName,
      });
      const aiReply = response.data?.reply || response.data?.data?.reply || 'Sorry, I encountered an issue processing your request.';

      setMessages(prev => [
        ...prev,
        {
          sender: 'ai',
          text: aiReply,
          timestamp: new Date(),
          modelUsed: response.data?.modelUsed || 'meta-muse-spark',
          provider: response.data?.provider || 'meta',
        }
      ]);
    } catch {
      setMessages(prev => [
        ...prev,
        {
          sender: 'ai',
          text: 'I apologize, but I could not connect to the clinical decision support API at this moment.',
          timestamp: new Date()
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative">
      {/* Floating Lower-Right Talk-Through AI Assistant Pill */}
      <div
        data-testid="staff-floating-ai-assistant-pill"
        className="fixed bottom-6 right-6 z-40 select-none"
      >
        <button
          type="button"
          onClick={() => setIsOpen(prev => !prev)}
          aria-label="Staff AI Co-Pilot"
          aria-expanded={isOpen}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-full bg-gradient-to-r ${roleDisplay.color} text-white font-semibold text-xs sm:text-sm shadow-xl hover:shadow-2xl hover:scale-105 active:scale-95 transition-all duration-200 border border-white/25`}
        >
          <span className="text-base animate-pulse">{roleDisplay.icon}</span>
          <span>✨ AI Co-Pilot</span>
          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-white/25 text-white">
            Muse Spark
          </span>
        </button>
      </div>

      {/* Inline Launcher Button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className={`w-full py-3.5 px-4 bg-gradient-to-r ${roleDisplay.color} text-white font-bold rounded-2xl flex items-center justify-between shadow-lg shadow-indigo-500/10 hover:shadow-xl hover:shadow-indigo-500/20 hover:-translate-y-0.5 transition-all duration-300 animate-fade-in`}
          aria-label="Open AI Assistant"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-xl animate-pulse">{roleDisplay.icon}</span>
            <span className="text-sm font-semibold tracking-wide">{roleDisplay.title}</span>
          </div>
          <span className="text-xs bg-white/20 backdrop-blur px-2.5 py-0.5 rounded-full uppercase tracking-wider font-bold">Online</span>
        </button>
      )}

      {/* Main Expanded Widget Card (Docked Lower-Right + Inline) */}
      {isOpen && (
        <Card
          data-testid="staff-floating-ai-assistant-drawer"
          className="fixed bottom-20 right-6 z-50 w-[380px] max-w-[calc(100vw-2rem)] border border-purple-200/80 bg-white rounded-2xl shadow-2xl overflow-hidden animate-slide-in flex flex-col h-[410px] dark:bg-slate-800"
        >
          <CardHeader className={`bg-gradient-to-r ${roleDisplay.color} text-white py-3 px-4 flex flex-row items-center justify-between`}>
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <span>{roleDisplay.icon}</span> {roleDisplay.title}
            </CardTitle>
            <button
              onClick={() => setIsOpen(false)}
              className="text-white/80 hover:text-white hover:bg-white/10 p-1.5 rounded-lg transition-all"
              aria-label="Minimize AI Assistant"
            >
              ✕
            </button>
          </CardHeader>
          
          <CardContent className="p-3 flex-1 flex flex-col justify-between overflow-hidden">
            {/* Conversation list */}
            <div className="flex-1 overflow-y-auto space-y-2.5 pr-1.5 scrollbar-thin">
              {messages.map((msg, index) => (
                <div
                  key={index}
                  className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed font-medium ${
                    msg.sender === 'user'
                      ? 'bg-indigo-600 text-white shadow-sm rounded-tr-none'
                      : 'bg-gray-100 text-gray-800 rounded-tl-none border border-gray-200/40'
                  }`}>
                    <div>{msg.text}</div>
                    {msg.sender === 'ai' && msg.modelUsed && (
                      <div className="mt-1.5 pt-1 border-t border-gray-200/60 flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
                        <span>🟢</span>
                        <span>Served by {msg.modelUsed}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 border border-gray-200/40 rounded-2xl rounded-tl-none px-4 py-3 text-xs text-gray-500 flex items-center gap-1.5 font-medium dark:text-gray-400 dark:bg-slate-700">
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Quick Suggestions Chips */}
            {messages.length === 1 && (
              <div className="py-2 flex flex-wrap gap-1.5">
                {roleDisplay.suggestions.map((suggestion, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleSend(suggestion)}
                    className="text-[10px] font-bold bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200/55 px-2.5 py-1 rounded-full transition-all text-left dark:bg-purple-900/20 dark:text-purple-300"
                  >
                    💡 {suggestion}
                  </button>
                ))}
              </div>
            )}

            {/* Input Bar */}
            <div className="mt-2 flex gap-2 border-t pt-2.5">
              <input
                type="text"
                className="flex-1 px-3.5 py-2.5 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-xs text-gray-800 shadow-inner placeholder-gray-400 dark:text-gray-100"
                placeholder="Ask me anything..."
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
              />
              <Button
                onClick={() => handleSend()}
                disabled={loading || !input.trim()}
                className={`bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold px-4`}
              >
                Send
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
