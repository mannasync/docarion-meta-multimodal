'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '@/store/auth.store';
import { consultationApi } from '@/services/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { toast } from 'react-toastify';
import { Paperclip, Send, Check, CheckCheck, X, Phone, Lock, PauseCircle, PlayCircle } from 'lucide-react';
import {
    AttachmentGallery, Lightbox, ChatAttachment,
    CHAT_ACCEPTED_TYPES, validateChatFiles, formatFileSize,
} from './ChatAttachments';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePresence } from '@/hooks/usePresence';

export type CareChannelScope = 'clinical' | 'nurse' | 'pharmacy' | 'delivery';
export type CareChannelStatus = 'open' | 'paused' | 'closed';

export interface ConsultationChatMessage {
    id: string;
    senderId: string;
    senderRole: string;
    channel?: CareChannelScope;
    message: string;
    attachments?: ChatAttachment[];
    timestamp: any;
    read: boolean;
    readAt?: any;
}

const CARE_CHANNEL_META: Array<{ id: CareChannelScope; label: string; shortLabel: string; icon: string; description: string }> = [
    { id: 'clinical', label: 'Doctor & Clinical', shortLabel: 'Doctor', icon: '🩺', description: 'Confidential doctor-patient clinical consultation' },
    { id: 'nurse', label: 'Nursing & Triage', shortLabel: 'Nurse', icon: '👩‍⚕️', description: 'Triage, vitals & nursing follow-up channel' },
    { id: 'pharmacy', label: 'Pharmacy Counseling', shortLabel: 'Pharmacy', icon: '💊', description: 'Medication counseling, dosage & dispensing channel' },
    { id: 'delivery', label: 'Medication Delivery', shortLabel: 'Delivery', icon: '🚚', description: 'Home delivery coordination & arrival updates' },
];

interface ConsultationChatProps {
    consultationId: string;
    status: string;
    initialMessages?: ConsultationChatMessage[];
    loading?: boolean;
    socket?: any;
    connected?: boolean;
    otherPartyName?: string;
    defaultChannel?: CareChannelScope;
    onCompleteConsultation?: () => void;
}

function toDate(val: any): Date | null {
    if (!val) return null;
    if (val._seconds) return new Date(val._seconds * 1000);
    if (val.seconds) return new Date(val.seconds * 1000);
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
}

function dayLabel(d: Date): string {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - day.getTime()) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Premium consultation chat — shared by the doctor and patient views of a
 * consultation. Real-time via Socket.IO (`chat:message`, `chat:read`,
 * `typing:*`), persisted server-side on the consultation's chatHistory,
 * with file/image sharing through the chat-upload storage pipeline.
 */
export default function ConsultationChat({
    consultationId, status, initialMessages, loading, socket, connected, otherPartyName, defaultChannel, onCompleteConsultation,
}: ConsultationChatProps) {
    const { user } = useAuthStore();

    // Uninterrupted in-consultation chat presence heartbeat (Milestone 3 / Requirement R3)
    usePresence({
        consultationId,
        inCall: false,
        status: 'in_consultation',
        intervalMs: 25_000,
        enabled: Boolean(consultationId),
    });

    const roleStr = String(user?.role || '');
    const initialChannel: CareChannelScope = useMemo(() => {
        if (defaultChannel) return defaultChannel;
        if (roleStr === 'pharmacist' || roleStr === 'pharmacy_admin') return 'pharmacy';
        if (roleStr === 'driver' || roleStr === 'dispatcher' || roleStr === 'delivery_driver') return 'delivery';
        return 'clinical';
    }, [defaultChannel, roleStr]);

    const [activeChannel, setActiveChannel] = useState<CareChannelScope>(initialChannel);
    const [allowedChannels, setAllowedChannels] = useState<CareChannelScope[]>(() => {
        if (roleStr === 'pharmacist' || roleStr === 'pharmacy_admin') return ['pharmacy', 'delivery'];
        if (roleStr === 'driver' || roleStr === 'dispatcher' || roleStr === 'delivery_driver') return ['delivery'];
        if (['nurse', 'midwife', 'care_home_nurse', 'theatre_nurse', 'dialysis_nurse'].includes(roleStr)) return ['nurse', 'clinical'];
        return ['clinical', 'nurse', 'pharmacy', 'delivery'];
    });
    const [channelStates, setChannelStates] = useState<Record<string, { status: CareChannelStatus; reason?: string | null }>>({});
    const [updatingChannel, setUpdatingChannel] = useState(false);

    const [messages, setMessages] = useState<ConsultationChatMessage[]>(initialMessages || []);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState('');
    const [stagedFiles, setStagedFiles] = useState<File[]>([]);
    const [uploading, setUploading] = useState(false);
    const [otherTyping, setOtherTyping] = useState(false);
    const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const typingClearRef = useRef<NodeJS.Timeout | null>(null);
    const seededRef = useRef(false);

    const currentChannelState: CareChannelStatus = channelStates[activeChannel]?.status || 'open';
    const isChannelOpen = currentChannelState === 'open';
    const baseCanSend = ['in_progress', 'accepted', 'confirmed', 'scheduled'].includes(status)
        || (roleStr === 'doctor' && !['completed', 'cancelled'].includes(status))
        || (activeChannel !== 'clinical' && status !== 'cancelled');
    const canSend = baseCanSend && isChannelOpen;
    const userId = user?.userId;
    const isParticipantRole = user?.role === 'patient' || user?.role === 'doctor';
    const isCareProvider = user?.role && user.role !== 'patient';

    // Seed from the consultation doc once it loads
    useEffect(() => {
        if (!seededRef.current && initialMessages && initialMessages.length > 0) {
            seededRef.current = true;
            setMessages(prev => {
                const known = new Set(prev.map(m => m.id));
                return [...initialMessages.filter(m => !known.has(m.id)), ...prev]
                    .sort((a, b) => (toDate(a.timestamp)?.getTime() || 0) - (toDate(b.timestamp)?.getTime() || 0));
            });
        }
    }, [initialMessages]);

    // Always hydrate from the dedicated messages endpoint, and poll every 4s
    // while active so real-time chat works seamlessly on serverless Cloud Functions.
    useEffect(() => {
        let active = true;
        const fetchMessages = (isInitial = false) => {
            consultationApi.getMessages(consultationId)
                .then((response) => {
                    if (active && Array.isArray(response.data?.data)) {
                        setMessages(response.data.data);
                    }
                })
                .catch(() => {
                    // Silent retry on next poll interval
                });
            if (typeof consultationApi.getCareChannels === 'function') {
                consultationApi.getCareChannels(consultationId)
                    .then((res) => {
                        if (!active) return;
                        const d = res?.data?.data;
                        if (Array.isArray(d?.allowedChannels) && d.allowedChannels.length > 0) {
                            setAllowedChannels(d.allowedChannels);
                        }
                        if (d?.channels && typeof d.channels === 'object') {
                            setChannelStates(d.channels);
                        }
                    })
                    .catch(() => {});
            }
        };
        fetchMessages(true);
        const shouldPoll =
            process.env.NODE_ENV !== 'test' &&
            String(status || '').toLowerCase() !== 'cancelled';
        const intervalId = shouldPoll ? setInterval(() => fetchMessages(false), 4000) : null;
        return () => {
            active = false;
            if (intervalId) clearInterval(intervalId);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [consultationId, status]);

    const handleChannelStatusChange = async (nextStatus: CareChannelStatus) => {
        if (!isCareProvider || updatingChannel) return;
        setUpdatingChannel(true);
        try {
            const res = await consultationApi.updateCareChannel(
                consultationId,
                activeChannel,
                nextStatus,
                nextStatus === 'open' ? 'Channel reopened by care team' : `Channel ${nextStatus} by care team`,
            );
            const updated = res.data?.data?.state;
            if (updated) {
                setChannelStates(prev => ({ ...prev, [activeChannel]: updated }));
            }
            toast.success(
                nextStatus === 'open'
                    ? `${activeChannel} channel reopened`
                    : nextStatus === 'paused'
                        ? `${activeChannel} channel paused`
                        : `${activeChannel} channel closed`,
            );
        } catch (err: any) {
            toast.error(err?.response?.data?.error || 'Failed to update channel state');
        } finally {
            setUpdatingChannel(false);
        }
    };

    // Mark incoming messages as read. Receipt failures remain visible and are
    // never converted into an optimistic "read" state.
    const markRead = useCallback(() => {
        if (!userId || !isParticipantRole) return;
        const hasUnreadFromOther = messages.some(m => m.senderId !== userId && !m.read);
        if (hasUnreadFromOther) {
            consultationApi.markMessagesRead(consultationId)
                .then(() => consultationApi.getMessages(consultationId))
                .then((response) => {
                    if (Array.isArray(response.data?.data)) setMessages(response.data.data);
                })
                .catch(() => {
                    toast.error('Messages opened, but the read receipt could not be saved. Retry when connected.');
                });
        }
    }, [messages, userId, isParticipantRole, consultationId]);

    useEffect(() => { markRead(); }, [markRead]);

    // Socket wiring — live messages, read receipts, typing
    useEffect(() => {
        if (!socket) return;

        const handleMessage = (msg: ConsultationChatMessage & { consultationId?: string }) => {
            if (msg.consultationId && msg.consultationId !== consultationId) return;
            setMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
            setOtherTyping(false);
        };
        const handleRead = (data: { consultationId: string; readerId: string; readAt: string }) => {
            if (data.consultationId !== consultationId || data.readerId === userId) return;
            setMessages(prev => prev.map(m => (m.senderId === userId && !m.read ? { ...m, read: true, readAt: data.readAt } : m)));
        };
        const handleTypingStart = (data: { userId: string; consultationId?: string }) => {
            if (data.userId === userId) return;
            if (data.consultationId && data.consultationId !== consultationId) return;
            setOtherTyping(true);
            if (typingClearRef.current) clearTimeout(typingClearRef.current);
            typingClearRef.current = setTimeout(() => setOtherTyping(false), 4000);
        };
        const handleTypingStop = (data: { userId: string }) => {
            if (data.userId !== userId) setOtherTyping(false);
        };

        socket.on('chat:message', handleMessage);
        socket.on('chat:read', handleRead);
        socket.on('typing:start', handleTypingStart);
        socket.on('typing:stop', handleTypingStop);
        return () => {
            socket.off('chat:message', handleMessage);
            socket.off('chat:read', handleRead);
            socket.off('typing:start', handleTypingStart);
            socket.off('typing:stop', handleTypingStop);
        };
    }, [socket, consultationId, userId]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
    }, [messages, otherTyping]);

    const emitTyping = useCallback(() => {
        if (!socket || !canSend) return;
        socket.emit('typing:start', { consultationId });
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => {
            socket.emit('typing:stop', { consultationId });
        }, 2000);
    }, [socket, consultationId, canSend]);

    const refreshAttachmentUrl = useCallback(async (fileId: string): Promise<string | null> => {
        try {
            const res = await consultationApi.refreshChatAttachmentUrl(consultationId, fileId);
            return res.data?.data?.url || null;
        } catch { return null; }
    }, [consultationId]);

    const stageFiles = (list: FileList | null) => {
        if (!list) return;
        const files = [...stagedFiles, ...Array.from(list)];
        const error = validateChatFiles(files);
        if (error) { toast.error(error); return; }
        setStagedFiles(files);
    };

    const send = async () => {
        const text = draft.trim();
        if ((!text && stagedFiles.length === 0) || sending || uploading) return;
        setSending(true);
        setSendError('');
        try {
            let attachments: ChatAttachment[] = [];
            if (stagedFiles.length > 0) {
                setUploading(true);
                const upRes = await consultationApi.uploadChatFiles(consultationId, stagedFiles);
                attachments = upRes.data?.data || [];
                setUploading(false);
            }
            const res = activeChannel === 'clinical'
                ? await consultationApi.sendMessage(consultationId, text, attachments)
                : await consultationApi.sendMessage(consultationId, text, attachments, activeChannel);
            const sent = res.data?.data;
            if (sent) setMessages(prev => (prev.some(m => m.id === sent.id) ? prev : [...prev, sent]));
            setDraft('');
            setStagedFiles([]);
            socket?.emit('typing:stop', { consultationId });
        } catch {
            setSendError('Message not sent. Your draft and attachments are preserved; retry when the connection is available.');
            toast.error('Failed to send message');
        } finally {
            setSending(false);
            setUploading(false);
        }
    };

    const visibleMessages = useMemo(
        () => messages.filter(m => (m.channel || 'clinical') === activeChannel),
        [messages, activeChannel],
    );

    const channelCounts = useMemo(() => {
        const counts: Record<CareChannelScope, number> = { clinical: 0, nurse: 0, pharmacy: 0, delivery: 0 };
        for (const m of messages) {
            const ch = (m.channel || 'clinical') as CareChannelScope;
            if (counts[ch] !== undefined) counts[ch] += 1;
        }
        return counts;
    }, [messages]);

    // Group messages by day for separators
    const grouped = useMemo(() => {
        const groups: { label: string; items: ConsultationChatMessage[] }[] = [];
        for (const m of visibleMessages) {
            const d = toDate(m.timestamp) || new Date();
            const label = dayLabel(d);
            const last = groups[groups.length - 1];
            if (last && last.label === label) last.items.push(m);
            else groups.push({ label, items: [m] });
        }
        return groups;
    }, [visibleMessages]);

    const activeChannelMeta = CARE_CHANNEL_META.find(c => c.id === activeChannel) || CARE_CHANNEL_META[0];
    const voiceCallHref = `/consultations/${consultationId}/video?mode=audio${activeChannel !== 'clinical' ? `&channel=${activeChannel}` : ''}`;

    return (
        <Card className="flex-1 flex flex-col min-h-[400px]">
            <CardHeader className="pb-2 flex flex-col gap-2">
                <div className="flex flex-row items-center justify-between gap-2 flex-wrap">
                    <CardTitle className="text-lg">💬 Consultation Care-Line Tunnel</CardTitle>
                    <div className="flex items-center gap-2">
                        {isCareProvider && (
                            <a
                                href={voiceCallHref}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors"
                                aria-label="Start voice call"
                                title="Start a voice call with the patient on this care channel"
                            >
                                <Phone className="w-3.5 h-3.5" /> Voice Call
                            </a>
                        )}
                        {onCompleteConsultation && !['completed', 'cancelled'].includes(status) && (
                            <button
                                type="button"
                                onClick={onCompleteConsultation}
                                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold bg-green-600 text-white hover:bg-green-700 shadow-sm transition-colors"
                                data-testid="chat-complete-consultation-btn"
                            >
                                ✅ Complete Visit
                            </button>
                        )}
                        <span className="text-xs text-green-600 flex items-center gap-1.5 font-medium">
                            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" /> {connected ? 'Live' : 'Live Sync'}
                        </span>
                    </div>
                </div>

                {/* Stage-Scoped Care-Line Channel Selector */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 pt-0.5" role="tablist" aria-label="Care-line conversation stages">
                    {CARE_CHANNEL_META.filter(ch => allowedChannels.includes(ch.id)).map(ch => {
                        const isSelected = activeChannel === ch.id;
                        const chState = channelStates[ch.id]?.status || 'open';
                        const count = channelCounts[ch.id] || 0;
                        return (
                            <button
                                key={ch.id}
                                type="button"
                                role="tab"
                                aria-selected={isSelected}
                                onClick={() => setActiveChannel(ch.id)}
                                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all whitespace-nowrap border ${
                                    isSelected
                                        ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                                        : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-emerald-50 hover:border-emerald-200 dark:bg-slate-800 dark:text-gray-200 dark:border-slate-700'
                                }`}
                            >
                                <span aria-hidden="true">{ch.icon}</span>
                                <span>{ch.shortLabel}</span>
                                {count > 0 && (
                                    <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${isSelected ? 'bg-white/20 text-white' : 'bg-emerald-100 text-emerald-800'}`}>
                                        {count}
                                    </span>
                                )}
                                {chState !== 'open' && (
                                    <span className="text-[10px] opacity-80" title={`Channel ${chState}`}>
                                        {chState === 'paused' ? '⏸️' : '🔒'}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>

                {/* Channel Scope & Lifecycle Control Bar (Open / Pause / Close / Reopen) */}
                <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-xl bg-gray-50 border border-gray-200 text-xs dark:bg-slate-800/70 dark:border-slate-700">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                            currentChannelState === 'open'
                                ? 'bg-emerald-100 text-emerald-800'
                                : currentChannelState === 'paused'
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-gray-200 text-gray-700'
                        }`}>
                            {currentChannelState === 'open' ? '🟢 Open' : currentChannelState === 'paused' ? '⏸️ Paused' : '🔒 Closed'}
                        </span>
                        <span className="text-gray-600 truncate dark:text-gray-300">{activeChannelMeta.description}</span>
                    </div>
                    {isCareProvider && (
                        <div className="flex items-center gap-1.5 shrink-0">
                            {currentChannelState === 'open' ? (
                                <>
                                    <button
                                        type="button"
                                        disabled={updatingChannel}
                                        onClick={() => handleChannelStatusChange('paused')}
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100"
                                        title="Pause this conversation tunnel segment"
                                    >
                                        <PauseCircle className="w-3 h-3" /> Pause
                                    </button>
                                    <button
                                        type="button"
                                        disabled={updatingChannel}
                                        onClick={() => handleChannelStatusChange('closed')}
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-gray-100 text-gray-700 border border-gray-300 hover:bg-gray-200"
                                        title="Close this conversation tunnel segment after completing care"
                                    >
                                        <Lock className="w-3 h-3" /> Close
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        disabled={updatingChannel}
                                        onClick={() => handleChannelStatusChange('open')}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-600 text-white hover:bg-emerald-700"
                                        title="Reopen this conversation tunnel segment with the patient"
                                    >
                                        <PlayCircle className="w-3 h-3" /> Reopen Tunnel
                                    </button>
                                    {onCompleteConsultation && !['completed', 'cancelled'].includes(status) && (
                                        <button
                                            type="button"
                                            onClick={onCompleteConsultation}
                                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-green-700 text-white hover:bg-green-800 shadow-sm"
                                        >
                                            ✅ End & Hand Off Visit
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </div>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col p-4 pt-0">

                <div className="flex-1 overflow-y-auto space-y-3 mb-4 max-h-[420px] pr-1">
                    {loading ? (
                        <div className="space-y-3 pt-2" aria-hidden="true">
                            <div className="skeleton h-10 w-3/5 rounded-2xl rounded-bl-md" />
                            <div className="skeleton h-10 w-1/2 rounded-2xl rounded-br-md ml-auto" />
                            <div className="skeleton h-10 w-2/3 rounded-2xl rounded-bl-md" />
                            <div className="skeleton h-10 w-2/5 rounded-2xl rounded-br-md ml-auto" />
                        </div>
                    ) : visibleMessages.length > 0 ? (
                        grouped.map(group => (
                            <div key={group.label}>
                                {/* Day separator */}
                                <div className="flex items-center gap-3 my-3">
                                    <div className="flex-1 h-px bg-gray-100 dark:bg-slate-700" />
                                    <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{group.label}</span>
                                    <div className="flex-1 h-px bg-gray-100 dark:bg-slate-700" />
                                </div>
                                <div className="space-y-2">
                                    {group.items.map(msg => {
                                        const isOwn = msg.senderId === userId;
                                        const time = toDate(msg.timestamp);
                                        return (
                                            <div key={msg.id} className={`flex animate-fade-in-up ${isOwn ? 'justify-end' : 'justify-start'}`}>
                                                <div className={`max-w-[80%] px-4 py-2.5 rounded-2xl ${isOwn
                                                    ? 'bg-green-600 text-white rounded-br-md shadow-soft'
                                                    : 'bg-white ring-1 ring-gray-100 text-gray-900 rounded-bl-md shadow-card'}`}>
                                                    {!isOwn && (
                                                        <p className="text-[10px] font-semibold uppercase tracking-wider text-green-600 mb-0.5">
                                                            {(msg as any).senderName
                                                                ? (msg as any).senderName
                                                                : msg.senderRole === 'pharmacist' || msg.senderRole === 'pharmacy_admin' || (msg.channel === 'pharmacy' && msg.senderRole !== 'patient')
                                                                    ? '💊 Pharmacist'
                                                                    : ['nurse', 'midwife', 'care_home_nurse'].includes(String(msg.senderRole || ''))
                                                                        ? '👩‍⚕️ Nurse'
                                                                        : ['driver', 'dispatcher', 'delivery_driver'].includes(String(msg.senderRole || ''))
                                                                            ? '🚚 Delivery'
                                                                            : msg.senderRole === 'patient'
                                                                                ? 'Patient'
                                                                                : (otherPartyName || 'Doctor')}
                                                        </p>
                                                    )}
                                                    {msg.message && <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.message}</p>}
                                                    {msg.attachments && msg.attachments.length > 0 && (
                                                        <AttachmentGallery
                                                            attachments={msg.attachments}
                                                            refreshUrl={refreshAttachmentUrl}
                                                            isOwn={isOwn}
                                                            onOpenLightbox={(src, alt) => setLightbox({ src, alt })}
                                                        />
                                                    )}
                                                    <div className={`flex items-center gap-1 mt-1 ${isOwn ? 'justify-end text-green-100' : 'text-gray-400'}`}>
                                                        <span className="text-[10px]">
                                                            {time ? time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                                                        </span>
                                                        {isOwn && (
                                                            msg.read
                                                                ? <CheckCheck className="w-3.5 h-3.5" aria-label="Read" />
                                                                : <Check className="w-3.5 h-3.5 opacity-70" aria-label="Sent" />
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))
                    ) : (
                        <EmptyState
                            icon={<span aria-hidden="true">💬</span>}
                            title="No consultation messages yet"
                            description={canSend
                                ? 'Send the first care message when ready. Responses may not be immediate, and this channel must not be used for emergencies.'
                                : 'Messaging opens while the consultation is in progress. This channel is not monitored for emergencies.'}
                            className="py-4"
                        />
                    )}

                    {/* Typing indicator */}
                    {otherTyping && (
                        <div className="flex items-center gap-2 px-1 animate-fade-in">
                            <div className="bg-white ring-1 ring-gray-100 shadow-card rounded-2xl rounded-bl-md px-4 py-3 flex gap-1 dark:bg-slate-800">
                                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                            </div>
                            <span className="text-[10px] text-gray-500 dark:text-gray-400">{otherPartyName || 'Someone'} is typing…</span>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {canSend && (
                    <div>
                        {sendError && (
                            <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300" role="alert">
                                <span>{sendError}</span>
                                <button type="button" className="shrink-0 font-semibold underline" onClick={send}>Retry</button>
                            </div>
                        )}
                        {/* Staged attachments preview */}
                        {stagedFiles.length > 0 && (
                            <div className="flex flex-wrap gap-2 mb-2 animate-fade-in">
                                {stagedFiles.map((f, i) => (
                                    <span key={`${f.name}-${i}`} className="flex items-center gap-1.5 bg-green-50 border border-green-200 text-green-800 text-xs px-2.5 py-1.5 rounded-xl dark:bg-green-900/20 dark:text-green-300">
                                        <Paperclip className="w-3 h-3" />
                                        <span className="truncate max-w-[140px]">{f.name}</span>
                                        <span className="text-green-500">{formatFileSize(f.size)}</span>
                                        <button
                                            onClick={() => setStagedFiles(prev => prev.filter((_, j) => j !== i))}
                                            className="hover:text-green-950 transition-colors"
                                            aria-label={`Remove ${f.name}`}
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-2 items-center">
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                accept={CHAT_ACCEPTED_TYPES}
                                className="hidden"
                                onChange={e => { stageFiles(e.target.files); e.target.value = ''; }}
                            />
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="w-11 h-11 flex-shrink-0 rounded-full border border-gray-200 text-gray-500 hover:text-green-600 hover:border-green-300 hover:bg-green-50 flex items-center justify-center transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 dark:text-gray-400"
                                aria-label="Attach files"
                                title="Attach images or documents (max 10MB each)"
                            >
                                <Paperclip className="w-4 h-4" />
                            </button>
                            <input
                                type="text"
                                className="flex-1 px-4 py-3 border border-gray-200 rounded-full transition-shadow duration-200 focus:ring-2 focus:ring-green-500 focus:border-green-500 focus:outline-none"
                                placeholder="Type a message..."
                                value={draft}
                                onChange={e => { setDraft(e.target.value); emitTyping(); }}
                                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
                            />
                            <button
                                className="w-11 h-11 flex-shrink-0 rounded-full bg-green-600 hover:bg-green-700 text-white flex items-center justify-center transition-all active:scale-95 disabled:opacity-50 shadow-glow-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2"
                                onClick={send}
                                disabled={sending || uploading || (!draft.trim() && stagedFiles.length === 0)}
                                aria-label="Send message"
                            >
                                {sending || uploading
                                    ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                    : <Send className="w-4 h-4 ml-0.5" />}
                            </button>
                        </div>
                    </div>
                )}
            </CardContent>

            {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
        </Card>
    );
}
