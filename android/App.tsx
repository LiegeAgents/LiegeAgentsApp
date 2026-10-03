import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { s, C } from "./theme";

const API = "https://api.liegeagents.com";
const logo = require("./assets/logo.png");
const usdgLogo = require("./assets/usdg.png");
type IconName = React.ComponentProps<typeof Feather>["name"];
type Job = {
  id: string;
  title: string;
  status: string;
  agent_name?: string;
  settlement_asset?: string;
  budget_amount?: string;
  deadline_at?: string;
  created_at?: string;
};
type Proposal = {
  id: string;
  action: string;
  effective_status: string;
  status: string;
  expires_at?: string;
  created_at?: string;
};
type Entry = { id: string; type: string; created_at: string; reference?: string };
type Overview = { jobs: Job[]; proposals: Proposal[]; activity: Entry[] };
type Notice = {
  title: string;
  body: string;
  kind?: "success" | "error" | "info";
  action?: string;
  onAction?: () => void;
};
type Tab = "home" | "jobs" | "approvals";
const empty: Overview = { jobs: [], proposals: [], activity: [] };
const terminal = ["completed", "rejected", "expired", "cancelled"];
const readable = (value: string) =>
  value.replace(/[._-]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const date = (value?: string) =>
  value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`;
const formatAmount = (value?: string | number | null) => {
  if (value === undefined || value === null || value === "") return "—";
  const text = String(value);
  const match = text.match(/^(-?\d+)(?:\.(\d+))?$/);
  if (!match) return text;
  const fraction = (match[2] || "").replace(/0+$/, "");
  return fraction ? `${match[1]}.${fraction}` : match[1];
};

async function call(path: string, options: RequestInit = {}, token?: string) {
  const response = await fetch(API + path, {
    ...options,
    signal: AbortSignal.timeout(20000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      body?.error?.message || `Request failed (${response.status}). Please try again.`,
    );
  return body.data;
}
function Icon({
  name,
  size = 20,
  color = C.text,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return <Feather name={name} size={size} color={color} />;
}
function Tap({
  children,
  onPress,
  style,
  disabled = false,
  label,
}: {
  children: React.ReactNode;
  onPress: () => void;
  style?: any;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        style,
        {
          opacity: disabled ? 0.4 : pressed ? 0.72 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
      ]}
    >
      {children}
    </Pressable>
  );
}
function Button({
  title,
  onPress,
  secondary,
  busy,
  icon,
}: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
  busy?: boolean;
  icon?: IconName;
}) {
  return (
    <Tap
      disabled={busy}
      onPress={onPress}
      style={[s.button, secondary && s.secondary, (!icon || busy) && { justifyContent: "center" }]}
    >
      {busy ? (
        <ActivityIndicator color={C.bg} />
      ) : (
        <>
          <Text style={[s.buttonText, secondary && { color: C.text }]}>{title}</Text>
          {icon && <Icon name={icon} color={secondary ? C.text : C.bg} size={19} />}
        </>
      )}
    </Tap>
  );
}
function Brand() {
  return (
    <View style={s.brand}>
      <Image source={logo} style={s.brandIcon} />
      <Text style={s.wordmark}>
        liege<Text style={{ color: C.green }}>.</Text>
      </Text>
    </View>
  );
}
function Badge({ status }: { status: string }) {
  const color = ["pending", "submitted"].includes(status)
    ? C.amber
    : terminal.includes(status) && status !== "completed"
      ? C.muted
      : C.green;
  return (
    <View style={[s.badge, { backgroundColor: color + "12" }]}>
      <Text style={[s.badgeText, { color }]}>{readable(status)}</Text>
    </View>
  );
}
function Empty({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Icon name={icon} size={27} color={C.green} />
      </View>
      <Text style={s.cardTitle}>{title}</Text>
      <Text style={[s.body, s.centerText]}>{body}</Text>
    </View>
  );
}
function Feedback({ notice, close }: { notice: Notice | null; close: () => void }) {
  const dismiss = () => {
    close();
    if (notice?.kind === "success") notice.onAction?.();
  };
  const color = notice?.kind === "error" ? C.red : C.green;
  return (
    <Modal
      visible={!!notice}
      transparent
      animationType="fade"
      onRequestClose={dismiss}
      statusBarTranslucent
    >
      <View style={s.overlay}>
        <View accessibilityViewIsModal style={s.feedback}>
          <View style={[s.feedbackIcon, { backgroundColor: color + "14" }]}>
            <Icon
              name={
                notice?.kind === "error"
                  ? "alert-triangle"
                  : notice?.kind === "success"
                    ? "check"
                    : "info"
              }
              color={color}
              size={30}
            />
          </View>
          <Text style={s.modalTitle}>{notice?.title}</Text>
          <Text style={[s.body, s.centerText]}>{notice?.body}</Text>
          <Button
            title={notice?.action || "Got it"}
            onPress={() => {
              const action = notice?.onAction;
              close();
              action?.();
            }}
          />
          {notice?.kind === "info" && notice.onAction && (
            <Tap onPress={close} style={s.signOut}>
              <Text style={s.smallMuted}>Cancel</Text>
            </Tap>
          )}
        </View>
      </View>
    </Modal>
  );
}
function Sheet({
  visible,
  close,
  children,
}: {
  visible: boolean;
  close: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}
      statusBarTranslucent
    >
      <View style={s.sheetOverlay}>
        <Pressable
          accessibilityLabel="Close details"
          accessibilityRole="button"
          onPress={close}
          style={s.backdrop}
        />
        <SafeAreaView edges={["bottom"]} style={s.sheet}>
          <View style={s.handle} />
          <Tap style={s.sheetClose} onPress={close} label="Close">
            <Icon name="x" />
          </Tap>
          <ScrollView contentContainerStyle={s.sheetContent}>{children}</ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function Pair({
  onPaired,
  notify,
}: {
  onPaired: (token: string) => void;
  notify: (notice: Notice) => void;
}) {
  const [welcome, setWelcome] = useState(true);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const input = useRef<TextInput>(null);
  const pair = async (value: string) => {
    if (inFlight.current || !/^\d{8}$/.test(value)) return;
    inFlight.current = true;
    setBusy(true);
    Keyboard.dismiss();
    try {
      const data = await call("/v1/mobile/pair", {
        method: "POST",
        body: JSON.stringify({
          code: value,
          name: "Liege companion",
          platform: "android",
          appVersion: "0.1.0",
        }),
      });
      await SecureStore.setItemAsync("liege.refresh", data.refreshToken);
      await SecureStore.setItemAsync("liege.access", data.accessToken);
      await SecureStore.setItemAsync("liege.device", data.deviceId);
      notify({
        title: "You’re connected.",
        body: "Your Liege workspace is ready to go with you.",
        kind: "success",
        action: "Enter workspace",
        onAction: () => onPaired(data.accessToken),
      });
    } catch (error) {
      notify({
        title: "Couldn’t link this device",
        body: (error as Error).message,
        kind: "error",
        action: "Try again",
      });
      setCode("");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const update = (value: string) => {
    if (inFlight.current) return;
    const digits = value.replace(/\D/g, "").slice(0, 8);
    setCode(digits);
    if (digits.length === 8) void pair(digits);
  };
  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={s.onboarding}
        >
          {welcome ? (
            <>
              <View style={[s.orbit, { flexGrow: 1, minHeight: 275 }]}>
                <View style={s.orbitOuter} />
                <View style={s.orbitInner} />
                <Image source={logo} style={s.heroLogo} />
              </View>
              <Text style={s.welcomeTitle}>
                Agents work.{"\n"}
                <Text style={{ color: C.green }}>You’re the liege.</Text>
              </Text>
              <View style={{ height: 32 }} />
              <Button
                title="Connect your workspace"
                icon="arrow-right"
                onPress={() => setWelcome(false)}
              />
            </>
          ) : (
            <>
              <Tap
                label="Back to welcome"
                onPress={() => {
                  Keyboard.dismiss();
                  setWelcome(true);
                }}
                style={s.backButton}
              >
                <Icon name="arrow-left" />
                <Text style={s.small}>Back</Text>
              </Tap>
              <View style={s.pairSymbol}>
                <Icon name="link" size={32} color={C.green} />
              </View>
              <Text style={s.title}>Pair your device</Text>
              <Text style={s.body}>
                Get your code on the web: Workspace settings → Android companion.
              </Text>
              <View style={s.codeLabel}>
                <Text style={s.eyebrow}>8-DIGIT PAIRING CODE</Text>
              </View>
              <Pressable
                accessibilityLabel="Enter eight-digit pairing code"
                onPress={() => input.current?.focus()}
                style={s.codeWrap}
              >
                <View pointerEvents="none" style={s.codeCells}>
                  {Array.from({ length: 8 }, (_, i) => (
                    <View
                      key={i}
                      style={[
                        s.codeCell,
                        i === code.length && s.codeCellActive,
                        i === 4 && { marginLeft: 7 },
                      ]}
                    >
                      <Text style={s.codeDigit}>{code[i] || ""}</Text>
                    </View>
                  ))}
                </View>
                <TextInput
                  ref={input}
                  value={code}
                  onChangeText={update}
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  editable={!busy}
                  caretHidden
                  style={s.hiddenInput}
                  accessibilityLabel="Eight-digit pairing code"
                  onSubmitEditing={() => void pair(code)}
                />
              </Pressable>
              <View style={s.grow} />
              <Button
                title={busy ? "Connecting…" : "Pair device"}
                busy={busy}
                onPress={() => (code.length === 8 ? void pair(code) : input.current?.focus())}
              />
              <View style={s.securityNote}>
                <Text style={s.footerNote}>Code expires in 5 minutes</Text>
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function JobRow({ job, open }: { job: Job; open: () => void }) {
  return (
    <Tap onPress={open} style={s.jobRow}>
      <View style={s.jobIcon}>
        <Icon name={job.status === "completed" ? "check" : "cpu"} color={C.green} />
      </View>
      <View style={s.grow}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {job.title}
        </Text>
        <Text style={s.rowMeta} numberOfLines={1}>
          {job.agent_name || "Liege agent"} · {date(job.deadline_at)}
        </Text>
        <View style={{ marginTop: 10 }}>
          <Badge status={job.status} />
        </View>
        {job.budget_amount && (
          <View style={[s.inline, { marginTop: 10 }]}>
            <Text style={s.amount}>{formatAmount(job.budget_amount)}</Text>
            {(job.settlement_asset || "USDG").toUpperCase() === "USDG" && (
              <Image source={usdgLogo} style={s.assetIcon} accessibilityLabel="USDG token" />
            )}
          </View>
        )}
      </View>
      <Icon name="chevron-right" color={C.dim} size={18} />
    </Tap>
  );
}
function Section({
  title,
  action,
  onPress,
}: {
  title: string;
  action?: string;
  onPress?: () => void;
}) {
  return (
    <View style={s.sectionHead}>
      <Text style={s.sectionTitle}>{title}</Text>
      {action && (
        <Tap onPress={onPress!} style={s.inline}>
          <Text style={s.link}>{action}</Text>
          <Icon name="arrow-up-right" size={15} color={C.green} />
        </Tap>
      )}
    </View>
  );
}

function Workspace({
  token,
  onSignOut,
  notify,
}: {
  token: string;
  onSignOut: () => void;
  notify: (notice: Notice) => void;
}) {
  const [tab, setTab] = useState<Tab>("home");
  const [data, setData] = useState<Overview>(empty);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [history, setHistory] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [account, setAccount] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const requestLock = useRef(false);
  const decisionLock = useRef(false);
  const fade = useRef(new Animated.Value(1)).current;
  const load = async () => {
    if (requestLock.current) return;
    requestLock.current = true;
    setRefreshing(true);
    try {
      const overview = await call("/v1/mobile/overview", {}, token);
      const allJobs = new Map<string, Job>(overview.jobs.map((item: Job) => [item.id, item]));
      let offset: number | null | undefined = overview.nextJobsOffset;
      while (typeof offset === "number") {
        const page = await call(`/v1/mobile/overview?jobsOffset=${offset}`, {}, token);
        for (const item of page.jobs as Job[]) allJobs.set(item.id, item);
        const next = page.nextJobsOffset;
        if (typeof next === "number" && next <= offset)
          throw new Error("Job pagination did not advance. Please refresh.");
        offset = next;
      }
      setData({ ...overview, jobs: [...allJobs.values()] });
      setLoaded(true);
    } catch (e) {
      notify({
        title: "Couldn’t refresh your workspace",
        body: (e as Error).message,
        kind: "error",
        action: "Dismiss",
      });
    } finally {
      setRefreshing(false);
      requestLock.current = false;
    }
  };
  useEffect(() => {
    void load();
  }, [token]);
  const navigate = (next: Tab) => {
    setTab(next);
    fade.setValue(0.35);
    Animated.timing(fade, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  };
  const pending = data.proposals.filter((p) => p.effective_status === "pending");
  const active = data.jobs.filter((j) => !terminal.includes(j.status));
  const finished = data.jobs.filter((j) => j.status === "completed");
  const decide = async (decision: "approved" | "rejected") => {
    if (!proposal || decisionLock.current) return;
    decisionLock.current = true;
    setDeciding(true);
    try {
      await call(`/v1/mobile/proposals/${proposal.id}/${decision}`, { method: "POST" }, token);
      const id = proposal.id;
      setData((prev) => ({
        ...prev,
        proposals: prev.proposals.map((p) =>
          p.id === id ? { ...p, status: decision, effective_status: decision } : p,
        ),
      }));
      setProposal(null);
      notify({
        title: decision === "approved" ? "Approval recorded." : "Request declined.",
        body:
          decision === "approved"
            ? "Your decision has been saved. Approval does not mean the action has finished executing."
            : "This proposal has been rejected.",
        kind: "success",
      });
    } catch (e) {
      setProposal(null);
      notify({ title: "Decision wasn’t saved", body: (e as Error).message, kind: "error" });
    } finally {
      decisionLock.current = false;
      setDeciding(false);
    }
  };
  const web = () => {
    void Linking.openURL("https://www.liegeagents.com/app").catch(() =>
      notify({
        title: "Couldn’t open the browser",
        body: "Visit liegeagents.com/app in your browser.",
        kind: "error",
      }),
    );
  };
  const jobs = data.jobs.filter(
    (j) =>
      (filter === "All" ||
        (filter === "Active" ? !terminal.includes(j.status) : terminal.includes(j.status))) &&
      `${j.title} ${j.agent_name || ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <SafeAreaView style={s.safe} edges={["top", "left", "right"]}>
      <View style={s.topbar}>
        <Brand />
        <View style={s.inline}>
          <Tap label="Open approvals" onPress={() => navigate("approvals")} style={s.circle}>
            <Icon name="bell" size={20} />
          </Tap>
          <Tap label="Device settings" onPress={() => setAccount(true)} style={s.avatar}>
            <Icon name="user" size={20} color={C.green} />
          </Tap>
        </View>
      </View>
      <ScrollView
        key={tab}
        contentContainerStyle={s.main}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={load}
            tintColor={C.green}
            colors={[C.green]}
            progressBackgroundColor={C.panel}
          />
        }
      >
        <Animated.View style={{ opacity: fade }}>
          {tab === "home" ? (
            <>
              <Text style={s.title}>
                Stay in the loop<Text style={{ color: C.green }}>.</Text>
              </Text>
              <Tap
                style={s.heroCard}
                onPress={() => {
                  setFilter("Active");
                  navigate("jobs");
                }}
              >
                <View style={s.heroRing} />
                <View style={s.heroRingSmall} />
                <Image source={logo} style={s.cardLogo} />
                <Text style={s.heroNumber}>
                  {loaded ? String(active.length).padStart(2, "0") : "—"}
                </Text>
                <View style={s.between}>
                  <Text style={s.heroLabel}>Active jobs</Text>
                  <View style={s.heroArrow}>
                    <Icon name="arrow-up-right" color={C.bg} size={23} />
                  </View>
                </View>
              </Tap>
              <View style={s.metricRow}>
                <Tap style={s.metric} onPress={() => navigate("approvals")}>
                  <View style={s.between}>
                    <Icon name="shield" color={C.green} />
                    <Text style={s.metricNumber}>{loaded ? pending.length : "—"}</Text>
                  </View>
                  <Text style={s.metricLabel}>Awaiting you</Text>
                </Tap>
                <Tap
                  style={s.metric}
                  onPress={() => {
                    setFilter("Finished");
                    navigate("jobs");
                  }}
                >
                  <View style={s.between}>
                    <Icon name="check-circle" color={C.green} />
                    <Text style={s.metricNumber}>{loaded ? finished.length : "—"}</Text>
                  </View>
                  <Text style={s.metricLabel}>Completed jobs</Text>
                </Tap>
              </View>
              {pending.length > 0 && (
                <Tap style={s.attention} onPress={() => navigate("approvals")}>
                  <View style={s.attentionIcon}>
                    <Icon name="inbox" color={C.green} />
                  </View>
                  <View style={s.grow}>
                    <Text style={s.rowTitle}>Your agents are waiting</Text>
                    <Text style={s.rowMeta}>
                      {pending.length} request{pending.length === 1 ? "" : "s"} ready for your
                      review
                    </Text>
                  </View>
                  <Icon name="arrow-up-right" color={C.green} />
                </Tap>
              )}
              <Section
                title="On your radar"
                action="All jobs"
                onPress={() => {
                  setFilter("All");
                  navigate("jobs");
                }}
              />
              {!loaded ? (
                <ActivityIndicator color={C.green} style={{ margin: 30 }} />
              ) : data.jobs.length ? (
                <View style={s.list}>
                  {data.jobs.slice(0, 3).map((j) => (
                    <JobRow key={j.id} job={j} open={() => setJob(j)} />
                  ))}
                </View>
              ) : (
                <Empty
                  icon="briefcase"
                  title="Room for your next idea"
                  body="Create a job in your web workspace. You can follow its progress here."
                />
              )}
              <Section title="Recent activity" />
              {data.activity.length ? (
                <View style={s.list}>
                  {data.activity.slice(0, 5).map((entry) => (
                    <View key={entry.id} style={s.activityRow}>
                      <View style={s.activityDot}>
                        <Icon name="activity" size={16} color={C.green} />
                      </View>
                      <View style={s.grow}>
                        <Text style={s.rowTitle}>{readable(entry.type)}</Text>
                        <Text style={s.rowMeta}>
                          {entry.reference ? short(entry.reference) : "Workspace activity"}
                        </Text>
                      </View>
                      <Text style={s.smallMuted}>{date(entry.created_at)}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={s.body}>Your latest workspace activity will appear here.</Text>
              )}
            </>
          ) : tab === "jobs" ? (
            <>
              <Text style={s.title}>
                Your job desk<Text style={{ color: C.green }}>.</Text>
              </Text>
              <View style={s.search}>
                <Icon name="search" size={18} color={C.muted} />
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  style={s.searchInput}
                  placeholder="Find a job or agent"
                  placeholderTextColor={C.muted}
                  accessibilityLabel="Search jobs"
                />
                {search.length > 0 && (
                  <Tap onPress={() => setSearch("")} label="Clear search">
                    <Icon name="x" size={18} />
                  </Tap>
                )}
              </View>
              <View style={s.filters}>
                {["All", "Active", "Finished"].map((f) => (
                  <Tap
                    key={f}
                    onPress={() => setFilter(f)}
                    style={[s.filter, filter === f && s.filterActive]}
                  >
                    <Text style={[s.filterText, filter === f && { color: C.bg }]}>{f}</Text>
                  </Tap>
                ))}
              </View>
              {jobs.length ? (
                <View style={s.list}>
                  {jobs.map((j) => (
                    <JobRow key={j.id} job={j} open={() => setJob(j)} />
                  ))}
                </View>
              ) : (
                <Empty
                  icon="search"
                  title="A clear desk"
                  body={
                    search
                      ? "No jobs match that search. Try a different title or agent."
                      : "Jobs in this category will appear here."
                  }
                />
              )}
            </>
          ) : (
            <>
              <Text style={s.title}>
                Your call<Text style={{ color: C.green }}>.</Text>
              </Text>
              <View style={s.filters}>
                {["Pending", "History"].map((label, i) => (
                  <Tap
                    key={label}
                    onPress={() => setHistory(i === 1)}
                    style={[s.filter, history === (i === 1) && s.filterActive]}
                  >
                    <Text style={[s.filterText, history === (i === 1) && { color: C.bg }]}>
                      {label}
                      {i === 0 ? `  ${pending.length}` : ""}
                    </Text>
                  </Tap>
                ))}
              </View>
              {(history
                ? data.proposals.filter((p) => p.effective_status !== "pending")
                : pending
              ).map((p) => (
                <Tap key={p.id} onPress={() => setProposal(p)} style={s.proposalCard}>
                  <View style={s.between}>
                    <View style={s.jobIcon}>
                      <Icon name="command" color={C.green} />
                    </View>
                    <Badge status={p.effective_status} />
                  </View>
                  <Text style={[s.cardTitle, { marginTop: 20 }]}>{readable(p.action)}</Text>
                  <Text style={s.body}>Proposal {short(p.id)}</Text>
                  <View style={s.proposalFooter}>
                    <Text style={s.smallMuted}>
                      {p.effective_status === "pending" ? "Expires" : "Created"}{" "}
                      {date(p.effective_status === "pending" ? p.expires_at : p.created_at)}
                    </Text>
                    <View style={s.inline}>
                      <Text style={s.link}>Review</Text>
                      <Icon name="arrow-up-right" size={16} color={C.green} />
                    </View>
                  </View>
                </Tap>
              ))}
              {!(history
                ? data.proposals.some((p) => p.effective_status !== "pending")
                : pending.length) && (
                <Empty
                  icon="check-circle"
                  title={history ? "A fresh start" : "You’re all caught up"}
                  body={
                    history
                      ? "Your reviewed and expired requests will appear here."
                      : "Nothing needs your attention right now. New agent requests will land here."
                  }
                />
              )}
            </>
          )}
          <View style={s.endMark}>
            <View style={s.endLine} />
            <Image source={logo} style={s.endLogo} />
            <View style={s.endLine} />
          </View>
        </Animated.View>
      </ScrollView>
      <SafeAreaView edges={["bottom"]} style={s.dockWrap}>
        <View style={s.dock}>
          {(["home", "jobs", "approvals"] as Tab[]).map((item, i) => (
            <Tap
              key={item}
              onPress={() => navigate(item)}
              label={readable(item)}
              style={[s.dockItem, tab === item && s.dockSelected]}
            >
              <Icon
                name={(["home", "briefcase", "shield"] as IconName[])[i]}
                color={tab === item ? C.bg : C.muted}
                size={20}
              />
              <Text style={[s.dockLabel, tab === item && { color: C.bg }]}>{readable(item)}</Text>
              {item === "approvals" && pending.length > 0 && (
                <View style={[s.dockBadge, tab === item && { backgroundColor: C.bg }]}>
                  <Text style={s.dockBadgeText}>{pending.length}</Text>
                </View>
              )}
            </Tap>
          ))}
        </View>
      </SafeAreaView>
      <Sheet visible={!!job} close={() => setJob(null)}>
        {job && (
          <>
            <View style={s.sheetIcon}>
              <Icon name="briefcase" color={C.green} size={27} />
            </View>
            <Text style={s.eyebrow}>JOB DETAILS</Text>
            <Text style={s.sheetTitle}>{job.title}</Text>
            <Badge status={job.status} />
            <View style={s.details}>
              {[
                ["Agent", job.agent_name || "—"],
                ["Budget", job.budget_amount ? formatAmount(job.budget_amount) : "—"],
                ["Deadline", date(job.deadline_at)],
                ["Created", date(job.created_at)],
                ["Job ID", short(job.id)],
              ].map(([label, value]) => (
                <View key={label} style={s.detailRow}>
                  <Text style={s.smallMuted}>{label}</Text>
                  <View style={label === "Budget" ? s.amountDetail : undefined}>
                    <Text selectable style={s.detailValue}>
                      {value}
                    </Text>
                    {label === "Budget" &&
                      (job.settlement_asset || "USDG").toUpperCase() === "USDG" && (
                        <Image
                          source={usdgLogo}
                          style={s.assetIcon}
                          accessibilityLabel="USDG token"
                        />
                      )}
                  </View>
                </View>
              ))}
            </View>
            <Text style={s.body}>
              Open your web workspace for private deliverables and wallet actions.
            </Text>
            <Button title="Open web workspace" icon="external-link" onPress={web} />
          </>
        )}
      </Sheet>
      <Sheet
        visible={!!proposal}
        close={() => {
          if (!deciding) setProposal(null);
        }}
      >
        {proposal && (
          <>
            <View style={s.sheetIcon}>
              <Icon name="shield" color={C.green} size={27} />
            </View>
            <Text style={s.eyebrow}>AGENT REQUEST</Text>
            <Text style={s.sheetTitle}>{readable(proposal.action)}</Text>
            <Badge status={proposal.effective_status} />
            <View style={s.details}>
              <View style={s.detailRow}>
                <Text style={s.smallMuted}>Proposal</Text>
                <Text selectable style={s.detailValue}>
                  {short(proposal.id)}
                </Text>
              </View>
              <View style={s.detailRow}>
                <Text style={s.smallMuted}>Expires</Text>
                <Text style={s.detailValue}>{date(proposal.expires_at)}</Text>
              </View>
            </View>
            <Text style={s.body}>
              Only the action summary is available on mobile. Review the full request in your web
              workspace before approving anything you’re unsure about.
            </Text>
            <Tap onPress={web} style={s.webLink}>
              <Text style={s.link}>Review full request on web</Text>
              <Icon name="external-link" size={16} color={C.green} />
            </Tap>
            {proposal.effective_status === "pending" && (
              <View style={{ gap: 10 }}>
                <Button
                  title="Approve request"
                  busy={deciding}
                  onPress={() => void decide("approved")}
                />
                <Button
                  title="Decline request"
                  secondary
                  busy={deciding}
                  onPress={() => void decide("rejected")}
                />
              </View>
            )}
          </>
        )}
      </Sheet>
      <Sheet visible={account} close={() => setAccount(false)}>
        <View style={s.sheetIcon}>
          <Icon name="smartphone" size={27} color={C.green} />
        </View>
        <Text style={s.eyebrow}>YOUR COMPANION</Text>
        <Text style={s.sheetTitle}>Connected.{"\n"}On your terms.</Text>
        <Text style={s.body}>
          This device can follow your jobs and review requests. Manage paired devices from Workspace
          settings on the web.
        </Text>
        <View style={s.details}>
          {[
            ["eye", "Monitor your workspace"],
            ["shield", "Review agent requests"],
            ["lock", "Wallet actions stay on the web"],
          ].map(([icon, text]) => (
            <View style={s.detailRow} key={text}>
              <Icon name={icon as IconName} color={C.green} size={18} />
              <Text style={s.detailValue}>{text}</Text>
            </View>
          ))}
        </View>
        <Button title="Open web workspace" icon="external-link" onPress={web} />
        <Tap
          style={s.signOut}
          onPress={() => {
            setAccount(false);
            notify({
              title: "Sign out of this device?",
              body: "You’ll need a new pairing code to return. To revoke this device’s access, use Workspace settings on the web.",
              kind: "info",
              action: "Sign out",
              onAction: onSignOut,
            });
          }}
        >
          <Icon name="log-out" color={C.muted} size={17} />
          <Text style={s.smallMuted}>Sign out of this device</Text>
        </Tap>
      </Sheet>
    </SafeAreaView>
  );
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    SecureStore.getItemAsync("liege.access")
      .then(setToken)
      .catch(() =>
        setNotice({
          title: "Couldn’t restore your session",
          body: "Please pair this device again.",
          kind: "error",
        }),
      )
      .finally(() => setBooting(false));
  }, []);
  const signOut = async () => {
    try {
      await SecureStore.deleteItemAsync("liege.access");
      await SecureStore.deleteItemAsync("liege.refresh");
      await SecureStore.deleteItemAsync("liege.device");
      setToken(null);
    } catch {
      setNotice({ title: "Couldn’t sign out", body: "Please try again.", kind: "error" });
    }
  };
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {booting ? (
        <View style={s.splash}>
          <Image source={logo} style={s.splashLogo} />
          <Text style={s.wordmark}>liege.</Text>
          <ActivityIndicator style={{ marginTop: 30 }} color={C.green} />
        </View>
      ) : token ? (
        <Workspace token={token} onSignOut={signOut} notify={setNotice} />
      ) : (
        <Pair onPaired={setToken} notify={setNotice} />
      )}
      <Feedback notice={notice} close={() => setNotice(null)} />
    </SafeAreaProvider>
  );
}
