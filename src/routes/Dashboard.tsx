import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { Sheet } from "@/components/Sheet";
import { Users } from "@/components/icons";
import { Button, Field, Input, Skeleton, Spinner } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { useActiveTerm } from "@/hooks/useAcademicTerms";
import { assignmentStatus, useMyAssignments, useMyItemScores, useMySubmissions } from "@/hooks/useAssignments";
import {
  summarizeAttendance,
  useAttendanceRange,
  useDeptStudentAttendanceToday,
  useMyChildren,
} from "@/hooks/useAttendance";
import { STARTING_SCORE, summarizeBehaviorScore, useBehaviorRecords } from "@/hooks/useBehaviorRecords";
import { useLeaveApprovals } from "@/hooks/useLeave";
import { useDepartments } from "@/hooks/useProfiles";
import { useDepartmentSettings, useSchoolSettings } from "@/hooks/useSettings";
import { useStaffAttendanceRange } from "@/hooks/useStaffAttendance";
import {
  useCancelStudentLeaveRequest,
  usePendingStudentLeaveApprovals,
  useRequestStudentLeave,
  useStudentLeaveRequests,
} from "@/hooks/useStudentLeave";
import { useClockIn, useClockOut, useMyTimeClock } from "@/hooks/useTimeClock";
import { useDepartmentTeachingAssignments } from "@/hooks/useTeachingLoad";
import { type AttendanceStatus, type Profile, type StudentLeaveStatus, type Student } from "@/lib/database.types";
import { canManageAcademic } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { STATUS_LABEL } from "@/routes/Attendance";
import { loadStatus } from "@/routes/TeachingLoad";
import { bangkokTime } from "@/routes/TimeTracking";

const LEAVE_STATUS_LABEL: Record<StudentLeaveStatus, string> = {
  pending: "รออนุมัติ",
  approved: "อนุมัติแล้ว",
  rejected: "ไม่อนุมัติ",
  cancelled: "ยกเลิกแล้ว",
};

const LEAVE_STATUS_STYLE: Record<StudentLeaveStatus, string> = {
  pending: "bg-warning/15 text-warning",
  approved: "bg-success/15 text-success",
  rejected: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

const STATUS_ORDER: AttendanceStatus[] = ["present", "late", "absent", "leave"];
const MONTH_LABEL = new Intl.DateTimeFormat("th-TH", { month: "long", year: "numeric" }).format(new Date());

function currentMonthRange() {
  const now = new Date();
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { start, end };
}

function currentAcademicYearRange() {
  const now = new Date();
  return { start: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31` };
}

export function Dashboard() {
  const { profile, myStudent } = useAuth();
  const isParent = profile?.roles.includes("parent") ?? false;
  const { data: children = [] } = useMyChildren(isParent ? (profile?.id ?? null) : null);
  const { data: schoolSettings } = useSchoolSettings();
  const showClockWidget =
    !!profile && profile.roles.some((r) => schoolSettings?.time_tracking_roles.includes(r));

  return (
    <div className="space-y-6">
      {profile && canManageAcademic(profile.roles) && (
        <div className="mx-auto max-w-6xl">
          <ManagerOverviewSection profile={profile} />
        </div>
      )}

      <div className="mx-auto max-w-xl space-y-6">
        {showClockWidget && profile && (
          <QuickClockSection profileId={profile.id} departmentId={profile.department_id} />
        )}

        {myStudent && profile && <StudentLeaveSection student={myStudent} submittedBy={profile.id} />}
        {children.map(
          (child) => profile && <StudentLeaveSection key={child.id} student={child} submittedBy={profile.id} />,
        )}

        {myStudent && <AssignmentSummarySection student={myStudent} />}
        {children.map((child) => (
          <AssignmentSummarySection key={child.id} student={child} />
        ))}
        {myStudent && <AttendanceSummarySection student={myStudent} />}
        {children.map((child) => (
          <AttendanceSummarySection key={child.id} student={child} />
        ))}
        {myStudent && <BehaviorScoreSection student={myStudent} />}
        {children.map((child) => (
          <BehaviorScoreSection key={child.id} student={child} />
        ))}
      </div>
    </div>
  );
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** dept_head/director/super_admin only — see canManageAcademic. dept_head scopes to own department, org-wide sees the whole school, both via RLS on the underlying tables. */
function ManagerOverviewSection({ profile }: { profile: Profile }) {
  const navigate = useNavigate();
  const date = todayIso();

  const { data: studentAttendance, isLoading: studentAttendanceLoading } = useDeptStudentAttendanceToday(date);
  const { data: staffAttendance = [], isLoading: staffAttendanceLoading } = useStaffAttendanceRange(date, date);
  const { data: pendingStudentLeave = [], isLoading: studentLeaveLoading } = usePendingStudentLeaveApprovals();
  const { data: pendingStaffLeave = [], isLoading: staffLeaveLoading } = useLeaveApprovals("pending");

  const departmentId = profile.department_id;
  const { data: departments = [] } = useDepartments();
  const splitsByTerm = departments.find((d) => d.id === departmentId)?.code === "SEC";
  const { data: activeTerm } = useActiveTerm(departmentId);
  const academicYear = activeTerm?.academic_year ?? new Date().getFullYear() + 543;
  const term = splitsByTerm ? (activeTerm?.term_type === "term2" ? 2 : 1) : null;
  const { data: deptSettings } = useDepartmentSettings(departmentId);
  const { data: assignments, isLoading: teachingLoadLoading } = useDepartmentTeachingAssignments(
    departmentId,
    academicYear,
    term,
  );

  const staffAttendanceCounts = summarizeAttendance(staffAttendance);

  let outOfRangeTeachers: number | undefined;
  if (assignments) {
    const totals = new Map<string, number>();
    for (const a of assignments) totals.set(a.teacher_id, (totals.get(a.teacher_id) ?? 0) + a.periods_per_week);
    outOfRangeTeachers = [...totals.values()].filter(
      (total) => loadStatus(total, deptSettings?.min_periods_per_week ?? null, deptSettings?.max_periods_per_week ?? null) !== "ok",
    ).length;
  }

  const total = studentAttendance
    ? studentAttendance.present + studentAttendance.late + studentAttendance.absent + studentAttendance.leave
    : 0;
  const presentRate = total > 0 ? Math.round(((studentAttendance!.present + studentAttendance!.late) / total) * 100) : null;

  return (
    <section className="space-y-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <FadeUp delay={0} className="lg:col-span-2">
          <button
            type="button"
            onClick={() => navigate("/attendance")}
            className="tappable block w-full rounded-3xl bg-foreground p-6 text-left text-background shadow-lg"
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-background/50">
              อัตรามาเรียนวันนี้ · นักเรียน
            </p>
            {studentAttendanceLoading ? (
              <Skeleton className="mt-3 h-9 w-24 bg-background/20" />
            ) : (
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-4xl font-black tracking-tighter">
                  {presentRate === null ? "—" : `${presentRate}%`}
                </span>
                <span className="text-xs font-medium text-background/60">มา + สาย จากทั้งหมด {total} คน</span>
              </div>
            )}
            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-background/15">
              <div
                className="h-full rounded-full bg-background transition-[width]"
                style={{ width: `${presentRate ?? 0}%` }}
              />
            </div>
            {studentAttendance && (
              <p className="mt-3 text-xs text-background/70">
                มา <strong className="font-semibold text-background">{studentAttendance.present}</strong> · สาย{" "}
                <strong className="font-semibold text-background">{studentAttendance.late}</strong> · ขาด{" "}
                <strong className="font-semibold text-background">{studentAttendance.absent}</strong> · ลา{" "}
                <strong className="font-semibold text-background">{studentAttendance.leave}</strong>
              </p>
            )}
          </button>
        </FadeUp>

        <FadeUp delay={80}>
          <button
            type="button"
            onClick={() => navigate("/staff-attendance")}
            className="tappable flex h-full w-full flex-col justify-center gap-3 rounded-3xl border border-border bg-card p-6 text-left"
          >
            <div className="flex items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
                <Users className="h-4 w-4 text-muted-foreground" />
              </div>
              <h4 className="font-bold">ครูมาทำงานวันนี้</h4>
            </div>
            {staffAttendanceLoading ? (
              <Skeleton className="h-4 w-40" />
            ) : (
              <p className="text-sm text-muted-foreground">
                มา <strong className="font-semibold text-foreground">{staffAttendanceCounts.present}</strong> · สาย{" "}
                <strong className="font-semibold text-foreground">{staffAttendanceCounts.late}</strong> · ขาด{" "}
                <strong className="font-semibold text-foreground">{staffAttendanceCounts.absent}</strong> · ลา{" "}
                <strong className="font-semibold text-foreground">{staffAttendanceCounts.leave}</strong>
              </p>
            )}
          </button>
        </FadeUp>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          delay={160}
          label="คำขอลานักเรียนค้าง"
          value={pendingStudentLeave.length}
          unit="รายการ"
          loading={studentLeaveLoading}
          warn={pendingStudentLeave.length > 0}
          onClick={() => navigate("/attendance")}
        />
        <KpiTile
          delay={220}
          label="คำขอลาครู/บุคลากรค้าง"
          value={pendingStaffLeave.length}
          unit="รายการ"
          loading={staffLeaveLoading}
          warn={pendingStaffLeave.length > 0}
          onClick={() => navigate("/leave")}
        />
        <KpiTile
          delay={280}
          label="ครูภาระงานเกิน/ต่ำเกณฑ์"
          value={outOfRangeTeachers}
          unit="คน"
          loading={teachingLoadLoading}
          warn={!!outOfRangeTeachers}
          fallback="ดูภาระงานสอน"
          onClick={() => navigate("/teaching-load")}
        />
      </div>
    </section>
  );
}

/** Fades + rises in once on mount — no scroll-trigger, the dashboard is already in view when this renders. */
function FadeUp({ delay, className, children }: { delay: number; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn("animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500", className)}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

function KpiTile({
  delay,
  label,
  value,
  unit,
  loading,
  warn,
  fallback,
  onClick,
}: {
  delay: number;
  label: string;
  value: number | undefined;
  unit: string;
  loading: boolean;
  warn: boolean;
  fallback?: string;
  onClick: () => void;
}) {
  return (
    <FadeUp delay={delay}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "tappable w-full rounded-2xl border bg-card p-5 text-left transition-colors",
          warn ? "border-warning/40 hover:bg-warning/5" : "border-border hover:bg-muted",
        )}
      >
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{label}</p>
        {loading ? (
          <Skeleton className="mt-2 h-7 w-16" />
        ) : value === undefined ? (
          <p className="mt-2 text-sm text-accent underline">{fallback}</p>
        ) : (
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-2xl font-black tracking-tighter">{value}</span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-xs font-bold",
                warn ? "bg-warning/15 text-warning" : "bg-success/15 text-success",
              )}
            >
              {unit}
            </span>
          </div>
        )}
      </button>
    </FadeUp>
  );
}

/** Quick access to the full workspace at /time-tracking (history, ขอออกนอกโรงเรียน, approvals). */
function QuickClockSection({ profileId, departmentId }: { profileId: string; departmentId: string | null }) {
  const navigate = useNavigate();
  const toast = useToast();
  const date = todayIso();
  const { data: record, isLoading } = useMyTimeClock(profileId, date);
  const clockIn = useClockIn();
  const clockOut = useClockOut();

  function onClockIn() {
    clockIn.mutate(
      { profileId, departmentId, date },
      {
        onSuccess: () => toast("บันทึกเวลาเข้างานสำเร็จ"),
        onError: (err) => toast(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ", "error"),
      },
    );
  }

  function onClockOut() {
    clockOut.mutate(
      { profileId, departmentId, date },
      {
        onSuccess: () => toast("บันทึกเวลาออกงานสำเร็จ"),
        onError: (err) => toast(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ", "error"),
      },
    );
  }

  return (
    <section>
      {isLoading ? (
        <div role="status" aria-label="กำลังโหลด">
          <Skeleton className="h-4 w-56" />
        </div>
      ) : (
        <p className="text-sm">
          เวลาทำงานวันนี้ —{" "}
          {record?.clock_in_time ? (
            <>
              เข้างานเวลา <strong className="font-semibold">{bangkokTime(record.clock_in_time)}</strong>
              {record.clock_out_time && (
                <>
                  {" "}
                  ออกงานเวลา <strong className="font-semibold">{bangkokTime(record.clock_out_time)}</strong>
                </>
              )}
            </>
          ) : (
            "ยังไม่ได้บันทึกเวลาเข้างาน"
          )}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          disabled={!!record?.clock_in_time || clockIn.isPending}
          onClick={onClockIn}
        >
          {clockIn.isPending ? <Spinner className="h-3.5 w-3.5" /> : "เข้างาน"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!record?.clock_in_time || !!record?.clock_out_time || clockOut.isPending}
          onClick={onClockOut}
        >
          {clockOut.isPending ? <Spinner className="h-3.5 w-3.5" /> : "ออกงาน"}
        </Button>
        <button
          type="button"
          className="tappable ml-auto text-xs text-accent underline"
          onClick={() => navigate("/time-tracking")}
        >
          ดูทั้งหมด
        </button>
      </div>
    </section>
  );
}

/** role="student"/"parent" only — full to-do list + submit flow lives at /assignments. */
function AssignmentSummarySection({ student }: { student: Student }) {
  const navigate = useNavigate();
  const { data: items = [], isLoading } = useMyAssignments(student.id);
  const { data: scores } = useMyItemScores(student.id);
  const { data: submissions } = useMySubmissions(student.id);

  const counts = { missing: 0, submitted: 0, late: 0, graded: 0 };
  for (const item of items) {
    counts[assignmentStatus(item, submissions?.get(item.id) ?? null, scores?.has(item.id) ?? false)]++;
  }

  return (
    <section>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          งานของ {student.first_name} {student.last_name}
        </p>
        <button type="button" className="tappable text-xs text-accent underline" onClick={() => navigate("/assignments")}>
          ดูทั้งหมด
        </button>
      </div>
      {isLoading ? (
        <div role="status" aria-label="กำลังโหลด">
          <Skeleton className="mt-1 h-4 w-48" />
        </div>
      ) : items.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">ยังไม่มีงาน</p>
      ) : (
        <p className="mt-1 text-sm">
          <strong className="font-semibold">{counts.missing + counts.late}</strong> ยังไม่ส่ง ·{" "}
          <strong className="font-semibold">{counts.submitted}</strong> ส่งแล้ว ·{" "}
          <strong className="font-semibold">{counts.graded}</strong> ตรวจแล้ว
        </p>
      )}
    </section>
  );
}

/** role="student"/"parent" only — teacher/admin get the full check-in workspace at /attendance instead. */
function AttendanceSummarySection({ student }: { student: Student }) {
  const { start, end } = currentMonthRange();
  const { data: records = [], isLoading } = useAttendanceRange({
    studentId: student.id,
    startDate: start,
    endDate: end,
  });
  const counts = summarizeAttendance(records);

  return (
    <section>
      <p className="text-sm text-muted-foreground">
        การมาเรียนของ {student.first_name} {student.last_name} · {MONTH_LABEL}
      </p>
      {isLoading ? (
        <div role="status" aria-label="กำลังโหลด">
          <Skeleton className="mt-1 h-4 w-40" />
        </div>
      ) : (
        <p className="mt-1 text-sm">
          {STATUS_ORDER.map((st, i) => (
            <span key={st}>
              {i > 0 && " · "}
              <strong className="font-semibold">{counts[st]}</strong> {STATUS_LABEL[st]}
            </span>
          ))}{" "}
          วัน
        </p>
      )}
    </section>
  );
}

/** role="student"/"parent" only — teacher/admin get the roster workspace at /behavior instead. */
function BehaviorScoreSection({ student }: { student: Student }) {
  const { start, end } = currentAcademicYearRange();
  const { data: records = [], isLoading } = useBehaviorRecords({
    studentId: student.id,
    startDate: start,
    endDate: end,
  });
  const score = summarizeBehaviorScore(records);

  return (
    <section>
      <p className="text-sm text-muted-foreground">
        คะแนนพฤติกรรมของ {student.first_name} {student.last_name}
      </p>
      {isLoading ? (
        <div role="status" aria-label="กำลังโหลด">
          <Skeleton className="mt-1 h-4 w-32" />
        </div>
      ) : (
        <p className={cn("mt-1 text-sm", score < STARTING_SCORE ? "text-destructive" : "text-success")}>
          <strong className="text-lg font-semibold">{score}</strong> จาก {STARTING_SCORE} คะแนน
        </p>
      )}
    </section>
  );
}

/** role="student"/"parent" only — teacher/admin approve these at Attendance.tsx's "คำขอลา" view instead. */
function StudentLeaveSection({ student, submittedBy }: { student: Student; submittedBy: string }) {
  const toast = useToast();
  const { data: requests = [], isLoading } = useStudentLeaveRequests(student.id);
  const request = useRequestStudentLeave();
  const cancel = useCancelStudentLeaveRequest();
  const [open, setOpen] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");

  function reset() {
    setStartDate("");
    setEndDate("");
    setReason("");
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!startDate || !endDate || !reason.trim()) return;
    request.mutate(
      { studentId: student.id, submittedBy, startDate, endDate, reason: reason.trim() },
      {
        onSuccess: () => {
          toast("ส่งคำขอลาสำเร็จ");
          reset();
          setOpen(false);
        },
        onError: (err) => toast(err instanceof Error ? err.message : "ส่งคำขอไม่สำเร็จ", "error"),
      },
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          การลาของ {student.first_name} {student.last_name}
        </p>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          + ขอลา
        </Button>
      </div>

      {isLoading && (
        <ul className="divide-y divide-border" role="status" aria-label="กำลังโหลด">
          {[0, 1].map((i) => (
            <li key={i} className="flex items-center justify-between gap-2 py-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-4 w-14 rounded-full" />
            </li>
          ))}
        </ul>
      )}
      {!isLoading && requests.length === 0 && (
        <p className="text-sm">ยังไม่มีคำขอลา</p>
      )}
      {requests.length > 0 && (
        <ul className="divide-y divide-border text-sm">
          {requests.slice(0, 5).map((r) => {
            const cancellable = r.status === "pending";
            return (
              <li key={r.id} className="space-y-1 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {r.start_date} – {r.end_date} ({r.days} วัน)
                  </span>
                  <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs", LEAVE_STATUS_STYLE[r.status])}>
                    {LEAVE_STATUS_LABEL[r.status]}
                  </span>
                </div>
                {cancellable && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => cancel.mutate(r.id)}
                    disabled={cancel.isPending}
                  >
                    ยกเลิก
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Sheet
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
        title={`ขอลา — ${student.first_name} ${student.last_name}`}
        footer={
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={() => setOpen(false)}>
              ยกเลิก
            </Button>
            <Button
              type="submit"
              form={`request-student-leave-${student.id}`}
              className="flex-1"
              disabled={!startDate || !endDate || !reason.trim() || request.isPending}
            >
              {request.isPending ? <Spinner className="h-3 w-3" /> : "ส่งคำขอ"}
            </Button>
          </div>
        }
      >
        <form id={`request-student-leave-${student.id}`} className="space-y-4" onSubmit={submit}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="วันเริ่ม">
              <Input
                type="date"
                value={startDate}
                min={todayIso()}
                onChange={(e) => setStartDate(e.target.value)}
                required
              />
            </Field>
            <Field label="วันสิ้นสุด">
              <Input
                type="date"
                value={endDate}
                min={startDate || todayIso()}
                onChange={(e) => setEndDate(e.target.value)}
                required
              />
            </Field>
          </div>
          <Field label="เหตุผล">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              placeholder="เช่น ลาป่วย มีไข้"
            />
          </Field>
        </form>
      </Sheet>
    </section>
  );
}
