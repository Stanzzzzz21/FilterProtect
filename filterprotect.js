require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  Events,
  MessageFlags
} = require("discord.js");
const fs = require("fs");
// --- Render Port Fix ---
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("FilterProtect is running."));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

// ---------------- CONFIG STORAGE ----------------
let config = { guilds: {} };
const CONFIG_FILE = "./filterprotect_config.json";
if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    config = { guilds: {} };
  }
}
function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
function ensureGuildConfig(guildId) {
  if (!config.guilds[guildId]) {
    config.guilds[guildId] = {
      adminRole: null,
      logsChannelId: null,
      harshness: 2,
      setupOwnerId: null,
      modules: {
        textFilter: true,
        spamFilter: true,
        linkFilter: true,
        inviteFilter: true,
        gamblingFilter: true,
        drugsFilter: true,
        violenceFilter: true,
        selfharmFilter: true,
        scamFilter: true,
        groomingFilter: true,
        profanityFilter: true
      },
      strikes: {}
    };
  }
  return config.guilds[guildId];
}

// ---------------- LOGGING ----------------
async function logEvent(guild, guildConfig, title, description, fields = []) {
  try {
    let channel = guildConfig.logsChannelId
      ? guild.channels.cache.get(guildConfig.logsChannelId)
      : null;

    if (!channel) {
      channel = guild.channels.cache.find(
        c => c.name === "filterprotect-logs" && c.isTextBased()
      );
      if (!channel) {
        channel = await guild.channels.create({
          name: "filterprotect-logs",
          type: 0
        });
      }
      guildConfig.logsChannelId = channel.id;
      saveConfig();
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor("#ff5555")
      .setTimestamp();

    if (fields.length) embed.addFields(fields);

    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error("Log error:", e);
  }
}

// ---------------- WORD LISTS ----------------
const NSFW_WORDS = [
  "sex","porn","porno","pornhub","nude","nudes","naked","blowjob","bj","pussy","cock","dick","dildo",
  "anal","deepthroat","hentai","cum","cumshot","orgasm","tits","boobs","milf","fetish","bdsm","bondage",
  "horny","nsfw","onlyfans","sexting","strip","stripper","camgirl","camshow","jerk","jerking","masturbate",
  "masturbation","handjob","69","threesome","foursome","gangbang","creampie","facial","rimjob"
];

const PROFANITY = [
  "fuck","shit","bitch","whore","slut","bastard","cunt","dickhead","motherfucker","asshole","prick",
  "twat","wanker","bollocks","piss off","go fuck yourself","son of a bitch"
];

const VIOLENCE = [
  "kill","murder","stab","shoot","blood","gore","die","choke","strangled","decapitate","torture",
  "execute","assault","beat you","i will kill you","i will hurt you","i will stab you","i will shoot you"
];

const SELF_HARM = [
  "kys","kill yourself","go die","end yourself","suicide","self harm","cut myself","i want to die",
  "i want to kill myself","i want to end it","i hate my life"
];

const DRUGS = [
  "weed","cannabis","marijuana","coke","cocaine","heroin","meth","methamphetamine","pills","xanax",
  "ketamine","lsd","acid","molly","ecstasy","crack","opioids","opium","lean","codeine"
];

const GAMBLING = [
  "casino","slots","betting","roulette","blackjack","jackpot","poker","sportsbook","bet","wager",
  "stake","gamble","slot machine"
];

const SCAMS = [
  "free nitro","nitro generator","click here","verify your account","steam gift","crypto giveaway",
  "airdrop","investment bot","double your money","free robux","free vbucks","claim reward",
  "login to claim","you won","winner selected","congratulations click"
];

const GROOMING = [
  "send pics","send nudes","dont tell anyone","dont tell your parents","how old are you really",
  "are you alone","show me","private chat","secret chat","i can teach you","trust me only",
  "come meet me","dont tell your friends"
];

const LEET_VARIANTS = [
  "f4ck","f@ck","f*ck","f!ck",
  "sh1t","sh!t","5hit",
  "b1tch","b!tch","b*tch",
  "c0ck","c0c","c0q",
  "d1ck","d!ck","d!c",
  "wh0re","wh0r3","w#ore",
  "5lut","slvt","sl*t"
];

const BROKEN_WORDS = [
  "f u c k","f.u.c.k","f-u-c-k","f u-c k",
  "s h i t","s.h.i.t","s-h-i-t",
  "b i t c h","b.i.t.c.h","b-i-t-c-h",
  "c o c k","c.o.c.k","c-o-c-k"
];

const SYMBOL_VARIANTS = [
  "f@ck","f*ck","f#ck","f$ck",
  "sh!t","sh*t","sh#t",
  "b!tch","b*tch","b#tch",
  "c*ck","c@ck","c#ck"
];

const SHORTENED = [
  "fk","fck","fkc",
  "sht","sh1t","sh!t",
  "btch","b!tch","b1tch",
  "dck","d!ck","d1ck",
  "cck","c0ck","c0c"
];

const TEXT_FILTER = [
  ...NSFW_WORDS,
  ...PROFANITY,
  ...VIOLENCE,
  ...SELF_HARM,
  ...DRUGS,
  ...GAMBLING,
  ...SCAMS,
  ...GROOMING,
  ...LEET_VARIANTS,
  ...BROKEN_WORDS,
  ...SYMBOL_VARIANTS,
  ...SHORTENED
];

// spam map
const spamMap = {};

// ---------------- SETUP / SETTINGS SESSIONS ----------------
const setupSessions = {};   // userId -> { guildId, step, temp }
const settingsSessions = {}; // userId -> { guildId, step, temp }

// ---------------- READY ----------------
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ---------------- COMMANDS ----------------
client.on(Events.ClientReady, async () => {
  const commands = [
    {
      name: "setup",
      description: "Initial FilterProtect setup (owner / installer only)"
    },
    {
      name: "settings",
      description: "Change FilterProtect settings (admin role only)"
    }
  ];
  await client.application.commands.set(commands);
});

// ---------------- PERMISSION HELPERS ----------------
function isOwnerOrSetupUser(interaction, guildConfig) {
  if (interaction.user.id === interaction.guild.ownerId) return true;
  if (guildConfig.setupOwnerId && guildConfig.setupOwnerId === interaction.user.id) return true;
  return false;
}

function isAdminRole(interaction, guildConfig) {
  if (!guildConfig.adminRole) return false;
  return interaction.member.roles.cache.has(guildConfig.adminRole);
}

// ---------------- INTERACTIONS ----------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) return;

  const guildId = interaction.guild.id;
  const guildConfig = ensureGuildConfig(guildId);

  if (interaction.commandName === "setup") {
    if (!isOwnerOrSetupUser(interaction, guildConfig)) {
      return interaction.reply({
        content: "❌ Only the **server owner** or the **original setup user** can run `/setup`.",
        flags: MessageFlags.Ephemeral
      });
    }

    setupSessions[interaction.user.id] = {
      guildId,
      step: 1,
      temp: {
        adminRoleId: null,
        logsChannelId: null,
        harshness: 2
      }
    };

    await interaction.reply({
      content: "📩 Check your DMs — starting FilterProtect setup.",
      flags: MessageFlags.Ephemeral
    });

    try {
      const dm = await interaction.user.createDM();
      await dm.send(
        `🛡️ **FilterProtect Setup — Step 1/3**\n\n` +
        `Please mention the **admin role** (e.g. @Staff) or send its ID.\n` +
        `This role will be allowed to use moderation commands and /settings.\n\n` +
        `Type \`cancel\` to stop.`
      );
    } catch {
      return interaction.followUp({
        content: "❌ I couldn't DM you. Please enable DMs from server members and try again.",
        flags: MessageFlags.Ephemeral
      });
    }

    return;
  }

  if (interaction.commandName === "settings") {
    if (!isAdminRole(interaction, guildConfig)) {
      return interaction.reply({
        content: "❌ Only members with the configured **admin role** can use `/settings`.",
        flags: MessageFlags.Ephemeral
      });
    }

    settingsSessions[interaction.user.id] = {
      guildId,
      step: 1,
      temp: {
        harshness: guildConfig.harshness,
        modules: { ...guildConfig.modules },
        logsChannelId: guildConfig.logsChannelId
      }
    };

    await interaction.reply({
      content: "📩 Check your DMs — opening FilterProtect settings.",
      flags: MessageFlags.Ephemeral
    });

    try {
      const dm = await interaction.user.createDM();
      await dm.send(
        `🛡️ **FilterProtect Settings — Step 1/3**\n\n` +
        `Current harshness: **${guildConfig.harshness}**\n` +
        `Send a number **1–4** to change it:\n` +
        `1 = Soft (delete + warn)\n` +
        `2 = Medium (delete + warn + strike)\n` +
        `3 = Hard (delete + timeout)\n` +
        `4 = Extreme (delete + timeout + auto‑kick at 3 strikes)\n\n` +
        `Or type \`skip\` to keep it.\n` +
        `Type \`cancel\` to stop.`
      );
    } catch {
      return interaction.followUp({
        content: "❌ I couldn't DM you. Please enable DMs from server members and try again.",
        flags: MessageFlags.Ephemeral
      });
    }

    return;
  }
});

// ---------------- DM WIZARD HANDLING ----------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.guild) return; // only DMs here

  const userId = message.author.id;
  const content = message.content.trim();

  // SETUP WIZARD
  if (setupSessions[userId]) {
    const session = setupSessions[userId];
    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) {
      delete setupSessions[userId];
      return message.channel.send("❌ Guild not found. Setup cancelled.");
    }
    const guildConfig = ensureGuildConfig(guild.id);

    if (content.toLowerCase() === "cancel") {
      delete setupSessions[userId];
      return message.channel.send("❌ Setup cancelled.");
    }

    // STEP 1: admin role
    if (session.step === 1) {
      let roleId = null;

      const mention = content.match(/^<@&(\d+)>$/);
      if (mention) roleId = mention[1];
      else if (/^\d+$/.test(content)) roleId = content;

      const role = roleId ? guild.roles.cache.get(roleId) : null;
      if (!role) {
        return message.channel.send(
          "❌ I couldn't find that role in the server.\n" +
          "Please mention the role (e.g. @Staff) or send its ID."
        );
      }

      session.temp.adminRoleId = role.id;
      session.step = 2;
      setupSessions[userId] = session;

      return message.channel.send(
        `✅ Admin role set to **${role.name}**.\n\n` +
        `🛡️ **Step 2/3 — Logs Channel**\n` +
        `Please mention the **logs channel** (e.g. #filterprotect-logs), or type \`auto\` to let me create one.\n` +
        `Type \`cancel\` to stop.`
      );
    }

    // STEP 2: logs channel
    if (session.step === 2) {
      let logsChannelId = null;

      if (content.toLowerCase() === "auto") {
        logsChannelId = null; // will auto-create
      } else {
        const mention = content.match(/^<#(\d+)>$/);
        if (mention) logsChannelId = mention[1];
        else if (/^\d+$/.test(content)) logsChannelId = content;

        const ch = logsChannelId ? guild.channels.cache.get(logsChannelId) : null;
        if (!ch || !ch.isTextBased()) {
          return message.channel.send(
            "❌ I couldn't find that text channel in the server.\n" +
            "Please mention the channel (e.g. #logs) or type `auto`."
          );
        }
      }

      session.temp.logsChannelId = logsChannelId;
      session.step = 3;
      setupSessions[userId] = session;

      return message.channel.send(
        `✅ Logs channel ${logsChannelId ? `set to <#${logsChannelId}>` : "will be auto‑created."}\n\n` +
        `🛡️ **Step 3/3 — Harshness**\n` +
        `Send a number **1–4**:\n` +
        `1 = Soft (delete + warn)\n` +
        `2 = Medium (delete + warn + strike)\n` +
        `3 = Hard (delete + timeout)\n` +
        `4 = Extreme (delete + timeout + auto‑kick at 3 strikes)\n\n` +
        `Type \`cancel\` to stop.`
      );
    }

    // STEP 3: harshness + save
    if (session.step === 3) {
      const n = Number(content);
      if (![1, 2, 3, 4].includes(n)) {
        return message.channel.send("❌ Please send a number between **1** and **4**.");
      }

      session.temp.harshness = n;

      // APPLY CONFIG
      guildConfig.adminRole = session.temp.adminRoleId;
      guildConfig.harshness = session.temp.harshness;
      guildConfig.setupOwnerId = userId;

      if (session.temp.logsChannelId) {
        guildConfig.logsChannelId = session.temp.logsChannelId;
      } else {
        // auto-create logs channel
        try {
          const ch = await guild.channels.create({
            name: "filterprotect-logs",
            type: 0
          });
          guildConfig.logsChannelId = ch.id;
        } catch (e) {
          console.error("Auto logs create error:", e);
        }
      }

      saveConfig();
      delete setupSessions[userId];

      await message.channel.send(
        `✅ **FilterProtect setup complete for \`${guild.name}\`.**\n\n` +
        `Admin role: <@&${guildConfig.adminRole}>\n` +
        `Logs channel: ${guildConfig.logsChannelId ? `<#${guildConfig.logsChannelId}>` : "Not set"}\n` +
        `Harshness: **${guildConfig.harshness}**\n\n` +
        `You can now use \`/settings\` (admin role only) to tweak modules.`
      );

      await logEvent(
        guild,
        guildConfig,
        "✅ FilterProtect Setup Complete",
        `Setup completed via DM by ${message.author.tag}.`
      );

      return;
    }

    return;
  }

  // SETTINGS WIZARD
  if (settingsSessions[userId]) {
    const session = settingsSessions[userId];
    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) {
      delete settingsSessions[userId];
      return message.channel.send("❌ Guild not found. Settings cancelled.");
    }
    const guildConfig = ensureGuildConfig(guild.id);

    if (content.toLowerCase() === "cancel") {
      delete settingsSessions[userId];
      return message.channel.send("❌ Settings cancelled.");
    }

    // STEP 1: harshness
    if (session.step === 1) {
      if (content.toLowerCase() !== "skip") {
        const n = Number(content);
        if (![1, 2, 3, 4].includes(n)) {
          return message.channel.send("❌ Please send a number between **1** and **4**, or `skip`.");
        }
        session.temp.harshness = n;
      }

      session.step = 2;
      settingsSessions[userId] = session;

      return message.channel.send(
        `🛡️ **Settings — Step 2/3 (Modules)**\n\n` +
        `Current modules:\n` +
        `Text Filter: ${guildConfig.modules.textFilter ? "ON" : "OFF"}\n` +
        `Spam Filter: ${guildConfig.modules.spamFilter ? "ON" : "OFF"}\n` +
        `Link Filter: ${guildConfig.modules.linkFilter ? "ON" : "OFF"}\n` +
        `Invite Filter: ${guildConfig.modules.inviteFilter ? "ON" : "OFF"}\n` +
        `Gambling Filter: ${guildConfig.modules.gamblingFilter ? "ON" : "OFF"}\n` +
        `Drugs Filter: ${guildConfig.modules.drugsFilter ? "ON" : "OFF"}\n` +
        `Violence Filter: ${guildConfig.modules.violenceFilter ? "ON" : "OFF"}\n` +
        `Self‑harm Filter: ${guildConfig.modules.selfharmFilter ? "ON" : "OFF"}\n` +
        `Scam Filter: ${guildConfig.modules.scamFilter ? "ON" : "OFF"}\n` +
        `Grooming Filter: ${guildConfig.modules.groomingFilter ? "ON" : "OFF"}\n` +
        `Profanity Filter: ${guildConfig.modules.profanityFilter ? "ON" : "OFF"}\n\n` +
        `Send a comma‑separated list of modules to **toggle**, e.g.:\n` +
        `\`text, spam, links, profanity\`\n` +
        `Available keys: text, spam, links, invites, gambling, drugs, violence, selfharm, scams, grooming, profanity\n\n` +
        `Or type \`skip\` to keep them as they are.\n` +
        `Type \`cancel\` to stop.`
      );
    }

    // STEP 2: modules
    if (session.step === 2) {
      if (content.toLowerCase() !== "skip") {
        const keys = content
          .toLowerCase()
          .split(",")
          .map(x => x.trim())
          .filter(Boolean);

        const map = {
          text: "textFilter",
          spam: "spamFilter",
          links: "linkFilter",
          invites: "inviteFilter",
          gambling: "gamblingFilter",
          drugs: "drugsFilter",
          violence: "violenceFilter",
          selfharm: "selfharmFilter",
          scams: "scamFilter",
          grooming: "groomingFilter",
          profanity: "profanityFilter"
        };

        for (const k of keys) {
          const internal = map[k];
          if (internal && Object.prototype.hasOwnProperty.call(guildConfig.modules, internal)) {
            session.temp.modules[internal] = !session.temp.modules[internal];
          }
        }
      }

      session.step = 3;
      settingsSessions[userId] = session;

      return message.channel.send(
        `🛡️ **Settings — Step 3/3 (Logs Channel)**\n\n` +
        `Current logs channel: ${guildConfig.logsChannelId ? `<#${guildConfig.logsChannelId}>` : "Not set / auto"}\n\n` +
        `Mention a new logs channel (e.g. #logs), or type \`auto\` to let me create one if missing.\n` +
        `Or type \`skip\` to keep it.\n` +
        `Type \`cancel\` to stop.`
      );
    }

    // STEP 3: logs + save
    if (session.step === 3) {
      let logsChannelId = guildConfig.logsChannelId;

      if (content.toLowerCase() !== "skip") {
        if (content.toLowerCase() === "auto") {
          logsChannelId = null;
        } else {
          const mention = content.match(/^<#(\d+)>$/);
          if (mention) logsChannelId = mention[1];
          else if (/^\d+$/.test(content)) logsChannelId = content;

          if (logsChannelId) {
            const ch = guild.channels.cache.get(logsChannelId);
            if (!ch || !ch.isTextBased()) {
              return message.channel.send(
                "❌ I couldn't find that text channel in the server.\n" +
                "Please mention the channel, send its ID, `auto`, or `skip`."
              );
            }
          }
        }
      }

      // APPLY
      guildConfig.harshness = session.temp.harshness;
      guildConfig.modules = session.temp.modules;

      if (logsChannelId) {
        guildConfig.logsChannelId = logsChannelId;
      } else {
        try {
          const ch = await guild.channels.create({
            name: "filterprotect-logs",
            type: 0
          });
          guildConfig.logsChannelId = ch.id;
        } catch (e) {
          console.error("Auto logs create error:", e);
        }
      }

      saveConfig();
      delete settingsSessions[userId];

      await message.channel.send(
        `✅ **FilterProtect settings updated for \`${guild.name}\`.**\n\n` +
        `Harshness: **${guildConfig.harshness}**\n` +
        `Logs channel: ${guildConfig.logsChannelId ? `<#${guildConfig.logsChannelId}>` : "Not set"}\n` +
        `Modules updated.`
      );

      await logEvent(
        guild,
        guildConfig,
        "⚙️ FilterProtect Settings Updated",
        `Settings updated via DM by ${message.author.tag}.`
      );

      return;
    }

    return;
  }
});

// ---------------- GUILD JOIN ----------------
client.on(Events.GuildCreate, async (guild) => {
  ensureGuildConfig(guild.id);
  saveConfig();

  const channel = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased());
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("👋 Welcome to FilterProtect")
    .setDescription(
      "Thanks for adding **FilterProtect**.\n\n" +
      "Use `/setup` (server owner) to configure the bot.\n" +
      "After setup, admins can use `/settings` via DMs."
    )
    .setColor("#5865F2");

  await channel.send({ embeds: [embed] });
});

// ---------------- MESSAGE FILTERING ----------------
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  const guildId = message.guild.id;
  const guildConfig = ensureGuildConfig(guildId);
  const modules = guildConfig.modules;

  const raw = message.content || "";
  const lower = raw.toLowerCase();
  const normalized = lower.replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");

  async function punish(reason) {
    try {
      await message.delete().catch(() => {});
      const harsh = guildConfig.harshness;

      await message.channel.send({
        content: `⚠️ ${message.author}, ${reason}`
      }).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));

      if (harsh >= 2) {
        if (!guildConfig.strikes[message.author.id]) guildConfig.strikes[message.author.id] = 0;
        guildConfig.strikes[message.author.id]++;
        saveConfig();
      }

      if (harsh >= 3) {
        try {
          await message.member.timeout(10 * 60 * 1000, "FilterProtect auto-timeout");
        } catch {}
      }

      if (harsh === 4) {
        const strikes = guildConfig.strikes[message.author.id] || 0;
        if (strikes >= 3) {
          try {
            await message.member.kick("FilterProtect auto-kick (3 strikes)");
          } catch {}
        }
      }

      await logEvent(
        message.guild,
        guildConfig,
        "🚨 FilterProtect Action",
        reason,
        [
          { name: "User", value: `${message.author.tag} (${message.author.id})`, inline: true },
          { name: "Channel", value: `${message.channel}`, inline: true },
          { name: "Content", value: raw || "[no text]", inline: false }
        ]
      );
    } catch (e) {
      console.error("Punish error:", e);
    }
  }

  // TEXT FILTER
  if (modules.textFilter) {
    for (const word of TEXT_FILTER) {
      const wNorm = word.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");
      if (!wNorm) continue;
      if (normalized.includes(wNorm)) {
        if (
          NSFW_WORDS.includes(word) ||
          (PROFANITY.includes(word) && modules.profanityFilter) ||
          (VIOLENCE.includes(word) && modules.violenceFilter) ||
          (SELF_HARM.includes(word) && modules.selfharmFilter) ||
          (DRUGS.includes(word) && modules.drugsFilter) ||
          (GAMBLING.includes(word) && modules.gamblingFilter) ||
          (SCAMS.includes(word) && modules.scamFilter) ||
          (GROOMING.includes(word) && modules.groomingFilter) ||
          LEET_VARIANTS.includes(word) ||
          BROKEN_WORDS.includes(word) ||
          SYMBOL_VARIANTS.includes(word) ||
          SHORTENED.includes(word)
        ) {
          return punish("Inappropriate text detected.");
        }
      }
    }
  }

  // LINK / INVITE FILTER
  if (modules.linkFilter || modules.inviteFilter) {
    const linkRegex = /(https?:\/\/[^\s]+)/gi;
    if (linkRegex.test(lower)) {
      if (modules.inviteFilter && (lower.includes("discord.gg") || lower.includes("discord.com/invite"))) {
        return punish("Discord invite link blocked.");
      }
      if (modules.linkFilter) {
        return punish("Link blocked.");
      }
    }
  }

  // SPAM FILTER
  if (modules.spamFilter) {
    const now = Date.now();
    const key = `${guildId}-${message.author.id}`;
    if (!spamMap[key]) spamMap[key] = { last: 0, count: 0, lastMsg: "" };
    const data = spamMap[key];

    if (now - data.last < 1500) data.count++;
    else data.count = 1;

    if (raw === data.lastMsg) data.count++;

    data.last = now;
    data.lastMsg = raw;
    spamMap[key] = data;

    const caps = raw.replace(/[^A-Z]/g, "").length;
    const capsRatio = raw.length > 0 ? caps / raw.length : 0;

    const emojiCount = (raw.match(/<a?:\w+:\d+>/g) || []).length;
    const mentionCount = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);

    if (data.count >= 6 || capsRatio > 0.7 || emojiCount >= 8 || mentionCount >= 5) {
      return punish("Spam detected.");
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
