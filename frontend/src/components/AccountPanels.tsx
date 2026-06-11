import { type FormEvent, useState } from "react";
import { Camera, CheckCircle2, Image, KeyRound, LockKeyhole, Palette, Save, Settings, Signal, UserCircle, Volume2, X } from "lucide-react";
import type { Session } from "../types";

const appBase = import.meta.env.BASE_URL || "/";

function appPath(path: string) {
  const base = appBase.endsWith("/") ? appBase : `${appBase}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}
export function AccountSettingsModal({
  session,
  isDemo,
  onClose,
  onSessionUpdate
}: {
  session: Session;
  isDemo: boolean;
  onClose: () => void;
  onSessionUpdate: (user: Session) => void;
}) {
  const [nickname, setNickname] = useState(session.nickname);
  const [avatarUrl, setAvatarUrl] = useState(session.avatar_url || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setProfileNotice(null);
    const nextNickname = nickname.trim();
    const nextAvatarUrl = avatarUrl.trim();
    const currentDanmakuColor = normalizeColorInput(session.danmaku_color) || "#FF5F9B";

    if (nextNickname.length < 2) {
      setProfileNotice({ type: "error", text: "Display name needs at least 2 characters." });
      return;
    }

    if (isDemo) {
      onSessionUpdate({ ...session, nickname: nextNickname, avatar_url: nextAvatarUrl, danmaku_color: currentDanmakuColor });
      setProfileNotice({ type: "success", text: "Demo profile updated in this preview." });
      return;
    }

    setProfileBusy(true);
    const response = await fetch(appPath("api/account/profile"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: nextNickname, avatarUrl: nextAvatarUrl, danmakuColor: currentDanmakuColor })
    });
    setProfileBusy(false);

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setProfileNotice({ type: "error", text: accountErrorMessage(payload?.error) });
      return;
    }

    onSessionUpdate(payload.user);
    setProfileNotice({ type: "success", text: "Profile saved." });
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    setPasswordNotice(null);

    if (nextPassword !== confirmPassword) {
      setPasswordNotice({ type: "error", text: "New passwords do not match." });
      return;
    }
    if (nextPassword.length < 8) {
      setPasswordNotice({ type: "error", text: "Password needs at least 8 characters." });
      return;
    }

    if (isDemo) {
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      setPasswordNotice({ type: "success", text: "Demo password flow is preview-only." });
      return;
    }

    setPasswordBusy(true);
    const response = await fetch(appPath("api/account/password"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, nextPassword })
    });
    setPasswordBusy(false);

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setPasswordNotice({ type: "error", text: accountErrorMessage(payload?.error) });
      return;
    }

    setCurrentPassword("");
    setNextPassword("");
    setConfirmPassword("");
    setPasswordNotice({ type: "success", text: "Password updated." });
  }

  return (
    <div className="account-modal-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-settings-title">
        <header className="account-modal-header">
          <div className="account-modal-title">
            <AccountAvatar session={{ ...session, nickname, avatar_url: avatarUrl }} />
            <div>
              <span>联系人账号</span>
              <h3 id="account-settings-title">@{session.username || session.nickname}</h3>
            </div>
          </div>
          <button type="button" className="account-close-button" aria-label="关闭账号设置" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <form className="account-card" onSubmit={saveProfile}>
          <div className="account-section-heading">
            <UserCircle size={17} />
            <div>
              <strong>Profile</strong>
              <span>昵称和头像会显示在星见终端。</span>
            </div>
          </div>
          <label>
            <span>Display name</span>
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              minLength={2}
              maxLength={24}
              placeholder="Your nickname"
              autoComplete="nickname"
            />
          </label>
          <label>
            <span>Avatar image URL</span>
            <input
              value={avatarUrl}
              onChange={(event) => setAvatarUrl(event.target.value)}
              maxLength={500}
              placeholder="https://.../avatar.png"
              autoComplete="photo"
            />
          </label>
          <div className="avatar-url-help">
            <Image size={14} />
            <span>Leave blank to use initials. Uploaded avatar storage can be added later.</span>
          </div>
          {profileNotice ? <AccountNotice notice={profileNotice} /> : null}
          <button type="submit" className="account-save-button" disabled={profileBusy || nickname.trim().length < 2}>
            {profileBusy ? <Signal size={16} /> : <Save size={16} />}
            {profileBusy ? "Saving..." : "Save profile"}
          </button>
        </form>

        <form className="account-card" onSubmit={savePassword}>
          <div className="account-section-heading">
            <KeyRound size={17} />
            <div>
              <strong>Password</strong>
              <span>修改这个私密联系入口账号的密码。</span>
            </div>
          </div>
          <label>
            <span>Current password</span>
            <input
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              type="password"
              placeholder={isDemo ? "Demo preview" : "Current password"}
              autoComplete="current-password"
              disabled={isDemo}
            />
          </label>
          <label>
            <span>New password</span>
            <input
              value={nextPassword}
              onChange={(event) => setNextPassword(event.target.value)}
              type="password"
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
          </label>
          <label>
            <span>Confirm new password</span>
            <input
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              type="password"
              placeholder="Repeat new password"
              autoComplete="new-password"
            />
          </label>
          {passwordNotice ? <AccountNotice notice={passwordNotice} /> : null}
          <button
            type="submit"
            className="account-save-button secondary"
            disabled={passwordBusy || nextPassword.length < 8 || confirmPassword.length < 8 || (!isDemo && !currentPassword)}
          >
            {passwordBusy ? <Signal size={16} /> : <KeyRound size={16} />}
            {passwordBusy ? "Updating..." : "Update password"}
          </button>
        </form>
      </section>
    </div>
  );
}

export function RoomSettingsModal({
  session,
  isDemo,
  audioEnabled,
  onAudioEnabledChange,
  onClose,
  onSessionUpdate
}: {
  session: Session;
  isDemo: boolean;
  audioEnabled: boolean;
  onAudioEnabledChange: (enabled: boolean) => void;
  onClose: () => void;
  onSessionUpdate: (user: Session) => void;
}) {
  const [danmakuColor, setDanmakuColor] = useState(normalizeColorInput(session.danmaku_color) || "#FF5F9B");
  const [colorBusy, setColorBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const normalizedColor = normalizeColorInput(danmakuColor);

  async function saveDanmakuColor(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    if (!normalizedColor) {
      setNotice({ type: "error", text: "Choose a valid #RRGGBB danmaku color." });
      return;
    }

    if (isDemo) {
      onSessionUpdate({ ...session, danmaku_color: normalizedColor });
      setNotice({ type: "success", text: "Demo danmaku color updated." });
      return;
    }

    setColorBusy(true);
    const response = await fetch(appPath("api/account/profile"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nickname: session.nickname,
        avatarUrl: session.avatar_url || "",
        danmakuColor: normalizedColor
      })
    });
    setColorBusy(false);

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setNotice({ type: "error", text: accountErrorMessage(payload?.error) });
      return;
    }

    onSessionUpdate(payload.user);
    setNotice({ type: "success", text: "Danmaku color saved." });
  }

  return (
    <div className="account-modal-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="room-settings-title">
        <header className="account-modal-header">
          <div className="account-modal-title">
            <span className="settings-title-icon" aria-hidden="true"><Settings size={20} /></span>
            <div>
              <span>Room settings</span>
              <h3 id="room-settings-title">Sound and danmaku</h3>
            </div>
          </div>
          <button type="button" className="account-close-button" aria-label="Close room settings" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <section className="settings-card" aria-label="Sound settings">
          <div className="account-section-heading">
            <Volume2 size={17} />
            <div>
              <strong>Music sound</strong>
              <span>Control whether this device plays room music.</span>
            </div>
          </div>
          <button
            type="button"
            className={`settings-toggle ${audioEnabled ? "enabled" : ""}`}
            aria-pressed={audioEnabled}
            onClick={() => onAudioEnabledChange(!audioEnabled)}
          >
            <span>{audioEnabled ? "Sound on" : "Sound off"}</span>
            <i aria-hidden="true" />
          </button>
        </section>

        <form className="settings-card" onSubmit={saveDanmakuColor}>
          <div className="account-section-heading">
            <Palette size={17} />
            <div>
              <strong>Danmaku color</strong>
              <span>Choose the color attached to your own sent messages.</span>
            </div>
          </div>
          <label>
            <span>My danmaku color</span>
            <div className="danmaku-color-control">
              <input
                className="danmaku-color-swatch"
                value={normalizedColor || "#FF5F9B"}
                onChange={(event) => setDanmakuColor(event.target.value)}
                type="color"
                aria-label="Choose my danmaku color"
              />
              <input
                value={danmakuColor}
                onChange={(event) => setDanmakuColor(event.target.value)}
                maxLength={7}
                placeholder="#FF5F9B"
                spellCheck={false}
              />
            </div>
          </label>
          {notice ? <AccountNotice notice={notice} /> : null}
          <button type="submit" className="account-save-button" disabled={colorBusy || !normalizedColor}>
            {colorBusy ? <Signal size={16} /> : <Save size={16} />}
            {colorBusy ? "Saving..." : "Save color"}
          </button>
        </form>
      </section>
    </div>
  );
}

function AccountNotice({ notice }: { notice: { type: "success" | "error"; text: string } }) {
  return (
    <span className={`account-notice ${notice.type}`}>
      {notice.type === "success" ? <CheckCircle2 size={14} /> : <LockKeyhole size={14} />}
      {notice.text}
    </span>
  );
}

export function AccountAvatar({ session, size = "normal" }: { session: Pick<Session, "nickname" | "avatar_url">; size?: "tiny" | "normal" }) {
  const avatarUrl = session.avatar_url?.trim();
  return (
    <span className={`account-avatar ${size}`}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="" draggable={false} />
      ) : (
        <>
          <Camera size={size === "tiny" ? 13 : 18} />
          <strong>{avatarInitials(session.nickname)}</strong>
        </>
      )}
    </span>
  );
}
function accountErrorMessage(error: string | undefined) {
  if (error === "nickname_invalid") return "Display name needs 2-24 characters.";
  if (error === "avatar_url_invalid") return "Avatar must be a valid http(s), data image, or site-relative URL.";
  if (error === "danmaku_color_invalid") return "Danmaku color must be a valid #RRGGBB value.";
  if (error === "current_password_invalid") return "Current password is not correct.";
  if (error === "password_invalid") return "Password needs at least 8 characters.";
  if (error === "unauthorized") return "Session expired. Log in again.";
  return "Could not save account settings.";
}

function avatarInitials(nickname: string) {
  return nickname.trim().slice(0, 2).toUpperCase() || "ME";
}

function normalizeColorInput(color: string | undefined) {
  const value = String(color || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : "";
}
