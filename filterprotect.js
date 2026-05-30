// ---------- Render / Express keep-alive ----------
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_req, res) => res.send("FilterProtect is running."));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// ---------- Imports ----------
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder
} = require("discord.js");
const fs = require("fs");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CONFIG_FILE = "./filterprotect_config.json";

// ---------- Config ----------
let config = { guilds: {} };

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
      harshness: 2,
      scanningEnabled: true,
      punishmentsEnabled: true,
      logsChannelId: null,
      adminRoleId: null,
      strikes: {}
    };
  }
  return config.guilds[guildId];
}

// ---------- Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

// ---------- Utils ----------
function isOwnerOrAdmin(member) {
  if (!member || !member.guild) return false;
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  const guildConfig = ensureGuildConfig(member.guild.id);
  if (guildConfig.adminRoleId && member.roles.cache.has(guildConfig.adminRoleId)) return true;
  return false;
}

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

// ---------- Gemini Moderation ----------
async function geminiModerate(text, urls = []) {
  if (!GEMINI_API_KEY) {
    console.warn("No GEMINI_API_KEY set.");
    return { unsafe: false, severity: 1, categories: [], reason: "No API key" };
  }

  const prompt = `
You are an advanced moderation AI for a Discord server.

Analyze the following message and attached URLs (which may be images, videos, or external links).

Classify for:
- sexual content (including minors, grooming)
- nudity
- violence / gore
- hate / harassment / slurs
- self-harm / suicide
- extremism / terrorism
- scams / fraud / malware
- drugs / weapons
- highly explicit memes or content

Return ONLY a compact JSON object like:
{
  "unsafe": true,
  "severity": 1-4,
  "categories": ["sexual", "violence"],
  "reason": "short human-readable summary"
}

Where:
- unsafe = true if the message should be blocked
- severity:
  1 = mild (warning)
  2 = medium (strike)
  3 = high (timeout)
  4 = extreme (kick/ban level)
- categories = list of tags
- reason = short explanation

Message text:
${text || "[no text]"}

Attached URLs:
${urls.length ? urls.join("\n") : "[none]"}
`;

  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
        GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ]
        })
      }
    );

    const data = await res.json();
    const textResp =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      '{"unsafe":false,"severity":1,"categories":[],"reason":"no response"}';

    let parsed;
    try {
      parsed = JSON.parse(textResp);
    } catch {
      parsed = {
        unsafe: false,
        severity: 1,
        categories: [],
        reason: "parse error: " + textResp.slice(0, 120)
      };
    }

    return {
      unsafe: !!parsed.unsafe,
      severity: Number(parsed.severity) || 1,
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      reason: parsed.reason || "no reason"
    };
  } catch (e) {
    console.error("Gemini error:", e);
    return { unsafe: false, severity: 1, categories: [], reason: "Gemini error" };
  }
}

// ---------- Setup Sessions ----------
const setupSessions = new Map(); // key: userId

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("setup")
      .setDescription("Run FilterProtect setup (server owner / admins only)")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("settings")
      .setDescription("Open FilterProtect settings dashboard")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("log")
      .setDescription("Create a moderation log and add a strike")
      .addUserOption(o =>
        o.setName("user").setDescription("User to log").setRequired(true)
      )
      .addStringOption(o =>
        o.setName("reason").setDescription("Reason for the log").setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("strikes")
      .setDescription("View strikes for a user")
      .addUserOption(o =>
        o.setName("user").setDescription("User to check").setRequired(true)
      )
      .toJSON()
  ];

  await client.application.commands.set(commands);
  console.log("Slash commands registered.");
});

// ---------- /setup & /settings & /log & /strikes ----------
client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === "setup") {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: "❌ Setup must be run inside a server.",
          ephemeral: true
        });
      }

      if (!isOwnerOrAdmin(interaction.member)) {
        return interaction.reply({
          content: "❌ Only the **server owner**, **Administrators**, or **FilterProtect Admin** can run `/setup`.",
          ephemeral: true
        });
      }

      const guildId = interaction.guild.id;
      ensureGuildConfig(guildId);

      setupSessions.set(interaction.user.id, {
        guildId,
        step: 1,
        harshness: 2,
        createAdmin: true,
        createLogs: true
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fp_setup_next")
          .setLabel("Next ➜")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("fp_setup_cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger)
      );

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🛡️ FilterProtect Setup — Step 1/3")
            .setDescription(
              "Welcome to **FilterProtect**.\n\n" +
                "This wizard will:\n" +
                "• Create a `FilterProtect Admin` role\n" +
                "• Create a `filterprotect-logs` channel\n" +
                "• Let you choose **harshness**\n\n" +
                "Click **Next** to continue."
            )
            .setColor("#5865F2")
        ],
        components: [row],
        ephemeral: true
      });
    }

    if (commandName === "settings") {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: "❌ Settings must be used inside a server.",
          ephemeral: true
        });
      }

      if (!isOwnerOrAdmin(interaction.member)) {
        return interaction.reply({
          content: "❌ Only the **server owner**, **Administrators**, or **FilterProtect Admin** can use `/settings`.",
          ephemeral: true
        });
      }

      const guildConfig = ensureGuildConfig(interaction.guild.id);

      const embed = new EmbedBuilder()
        .setTitle("🛠️ FilterProtect Settings")
        .setDescription(
          `**Scanning:** ${guildConfig.scanningEnabled ? "✅ Enabled" : "❌ Disabled"}\n` +
            `**Punishments:** ${guildConfig.punishmentsEnabled ? "✅ Enabled" : "❌ Disabled"}\n` +
            `**Harshness:** **${guildConfig.harshness}** (1=soft, 4=extreme)\n\n` +
            "Use the buttons below to toggle features."
        )
        .setColor("#5865F2");

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fp_settings_toggle_scanning")
          .setLabel(
            guildConfig.scanningEnabled ? "Disable Scanning" : "Enable Scanning"
          )
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fp_settings_toggle_punish")
          .setLabel(
            guildConfig.punishmentsEnabled ? "Disable Punishments" : "Enable Punishments"
          )
          .setStyle(ButtonStyle.Secondary)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fp_settings_harsh_down")
          .setLabel("Harshness -")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fp_settings_harsh_up")
          .setLabel("Harshness +")
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({
        embeds: [embed],
        components: [row1, row2],
        ephemeral: true
      });
    }

    if (commandName === "log") {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: "❌ Must be used in a server.",
          ephemeral: true
        });
      }

      if (!isOwnerOrAdmin(interaction.member)) {
        return interaction.reply({
          content: "❌ You need **FilterProtect Admin**, **Administrator**, or be **server owner** to use `/log`.",
          ephemeral: true
        });
      }

      const target = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason", true);
      const guildConfig = ensureGuildConfig(interaction.guild.id);

      if (!guildConfig.strikes[target.id]) guildConfig.strikes[target.id] = 0;
      guildConfig.strikes[target.id]++;
      saveConfig();

      await logEvent(
        interaction.guild,
        guildConfig,
        "📝 Manual Log (Command)",
        `Log created via \`/log\`.\nTarget: **${target.tag}**\nReason: **${reason}**\nStrikes: **${guildConfig.strikes[target.id]}**`
      );

      return interaction.reply({
        content: `✅ Logged **${target.tag}** and added a strike. Total strikes: **${guildConfig.strikes[target.id]}**`,
        ephemeral: true
      });
    }

    if (commandName === "strikes") {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: "❌ Must be used in a server.",
          ephemeral: true
        });
      }

      const target = interaction.options.getUser("user", true);
      const guildConfig = ensureGuildConfig(interaction.guild.id);
      const count = guildConfig.strikes[target.id] || 0;

      return interaction.reply({
        content: `📊 **${target.tag}** has **${count}** strike(s).`,
        ephemeral: true
      });
    }
  }

  // ---------- Button handling (setup + settings) ----------
  if (interaction.isButton()) {
    const id = interaction.customId;

    // SETTINGS buttons
    if (id.startsWith("fp_settings_")) {
      if (!interaction.inGuild() || !isOwnerOrAdmin(interaction.member)) {
        return interaction.reply({
          content: "❌ You are not allowed to change settings.",
          ephemeral: true
        });
      }

      const guildConfig = ensureGuildConfig(interaction.guild.id);

      if (id === "fp_settings_toggle_scanning") {
        guildConfig.scanningEnabled = !guildConfig.scanningEnabled;
      }
      if (id === "fp_settings_toggle_punish") {
        guildConfig.punishmentsEnabled = !guildConfig.punishmentsEnabled;
      }
      if (id === "fp_settings_harsh_down") {
        guildConfig.harshness = Math.max(1, guildConfig.harshness - 1);
      }
      if (id === "fp_settings_harsh_up") {
        guildConfig.harshness = Math.min(4, guildConfig.harshness + 1);
      }

      saveConfig();

      const embed = new EmbedBuilder()
        .setTitle("🛠️ FilterProtect Settings")
        .setDescription(
          `**Scanning:** ${guildConfig.scanningEnabled ? "✅ Enabled" : "❌ Disabled"}\n` +
            `**Punishments:** ${guildConfig.punishmentsEnabled ? "✅ Enabled" : "❌ Disabled"}\n` +
            `**Harshness:** **${guildConfig.harshness}** (1=soft, 4=extreme)\n\n` +
            "Use the buttons below to toggle features."
        )
        .setColor("#5865F2");

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fp_settings_toggle_scanning")
          .setLabel(
            guildConfig.scanningEnabled ? "Disable Scanning" : "Enable Scanning"
          )
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fp_settings_toggle_punish")
          .setLabel(
            guildConfig.punishmentsEnabled ? "Disable Punishments" : "Enable Punishments"
          )
          .setStyle(ButtonStyle.Secondary)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fp_settings_harsh_down")
          .setLabel("Harshness -")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fp_settings_harsh_up")
          .setLabel("Harshness +")
          .setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row1, row2] });
    }

    // SETUP buttons
    const session = setupSessions.get(interaction.user.id);
    if (!session) return;

    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) {
      setupSessions.delete(interaction.user.id);
      return interaction.update({
        content: "❌ Guild not found. Setup cancelled.",
        embeds: [],
        components: []
      });
    }

    const guildConfig = ensureGuildConfig(guild.id);

    if (id === "fp_setup_cancel") {
      setupSessions.delete(interaction.user.id);
      return interaction.update({
        content: "❌ Setup cancelled.",
        embeds: [],
        components: []
      });
    }

    if (id === "fp_setup_prev") {
      session.step = Math.max(1, session.step - 1);
    } else if (id === "fp_setup_next") {
      session.step = Math.min(3, session.step + 1);
    }

    if (id.startsWith("fp_setup_harsh_")) {
      const level = Number(id.split("_").pop());
      if ([1, 2, 3, 4].includes(level)) session.harshness = level;
    }

    if (id === "fp_setup_toggle_admin") {
      session.createAdmin = !session.createAdmin;
    }
    if (id === "fp_setup_toggle_logs") {
      session.createLogs = !session.createLogs;
    }

    if (id === "fp_setup_finish") {
      guildConfig.harshness = session.harshness;

      if (session.createAdmin) {
        let role = guild.roles.cache.find(r => r.name === "FilterProtect Admin");
        if (!role) {
          role = await guild.roles.create({
            name: "FilterProtect Admin",
            permissions: [PermissionsBitField.Flags.ManageMessages]
          });
        }
        guildConfig.adminRoleId = role.id;
      }

      if (session.createLogs) {
        let ch = guild.channels.cache.find(
          c => c.name === "filterprotect-logs" && c.isTextBased()
        );
        if (!ch) {
          ch = await guild.channels.create({
            name: "filterprotect-logs",
            type: 0
          });
        }
        guildConfig.logsChannelId = ch.id;
      }

      saveConfig();
      setupSessions.delete(interaction.user.id);

      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ FilterProtect Setup Complete")
            .setDescription(
              `Harshness: **${guildConfig.harshness}**\n` +
                `Admin role: ${
                  guildConfig.adminRoleId ? `<@&${guildConfig.adminRoleId}>` : "Not created"
                }\n` +
                `Logs channel: ${
                  guildConfig.logsChannelId ? `<#${guildConfig.logsChannelId}>` : "Not created"
                }\n\n` +
                "FilterProtect is now active and using **Gemini** to scan every message, link, image, and attachment."
            )
            .setColor("#57F287")
        ],
        components: []
      });

      await logEvent(
        guild,
        guildConfig,
        "✅ FilterProtect Setup Complete",
        `Setup finished by ${interaction.user.tag}.`
      );

      return;
    }

    // re-render setup step
    const step = session.step;
    let embed;
    let components = [];

    if (step === 1) {
      embed = new EmbedBuilder()
        .setTitle("🛡️ FilterProtect Setup — Step 1/3")
        .setDescription(
          "Welcome to **FilterProtect**.\n\n" +
            "This wizard will:\n" +
            "• Create a `FilterProtect Admin` role\n" +
            "• Create a `filterprotect-logs` channel\n" +
            "• Let you choose **harshness**\n\n" +
            "Click **Next** to continue."
        )
        .setColor("#5865F2");

      components = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("fp_setup_next")
            .setLabel("Next ➜")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("fp_setup_cancel")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Danger)
        )
      ];
    } else if (step === 2) {
      embed = new EmbedBuilder()
        .setTitle("🛡️ FilterProtect Setup — Step 2/3 (Harshness)")
        .setDescription(
          "Choose a **harshness level**:\n\n" +
            "1 = Soft (delete + warn)\n" +
            "2 = Medium (delete + warn + strike)\n" +
            "3 = Hard (delete + timeout)\n" +
            "4 = Extreme (delete + timeout + auto‑kick at 3 strikes)\n\n" +
            `Current selection: **${session.harshness}**`
        )
        .setColor("#FEE75C");

      components = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("fp_setup_harsh_1")
            .setLabel("1")
            .setStyle(session.harshness === 1 ? ButtonStyle.Success : ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("fp_setup_harsh_2")
            .setLabel("2")
            .setStyle(session.harshness === 2 ? ButtonStyle.Success : ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("fp_setup_harsh_3")
            .setLabel("3")
            .setStyle(session.harshness === 3 ? ButtonStyle.Success : ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("fp_setup_harsh_4")
            .setLabel("4")
            .setStyle(session.harshness === 4 ? ButtonStyle.Success : ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("fp_setup_prev")
            .setLabel("⬅ Previous")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("fp_setup_next")
            .setLabel("Next ➜")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("fp_setup_cancel")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Danger)
        )
      ];
    } else if (step === 3) {
      embed = new EmbedBuilder()
        .setTitle("🛡️ FilterProtect Setup — Step 3/3 (Roles & Logs)")
        .setDescription(
          "Choose what FilterProtect should create:\n\n" +
            `Admin role: **${session.createAdmin ? "Create `FilterProtect Admin`" : "Do not create"}**\n` +
            `Logs channel: **${
              session.createLogs ? "Create `filterprotect-logs`" : "Do not create"
            }**\n\n` +
            "Click **Finish** to apply settings."
        )
        .setColor("#57F287");

      components = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("fp_setup_toggle_admin")
            .setLabel(
              session.createAdmin ? "Disable Admin Role Creation" : "Enable Admin Role Creation"
            )
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("fp_setup_toggle_logs")
            .setLabel(
              session.createLogs ? "Disable Logs Channel Creation" : "Enable Logs Channel Creation"
            )
            .setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("fp_setup_prev")
            .setLabel("⬅ Previous")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("fp_setup_finish")
            .setLabel("Finish ✅")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("fp_setup_cancel")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Danger)
        )
      ];
    }

    await interaction.update({ embeds: [embed], components });
  }
});

// ---------- Moderation (Gemini scans every message) ----------
client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  const guildConfig = ensureGuildConfig(message.guild.id);
  if (!guildConfig.scanningEnabled) return;

  const text = message.content || "";
  const urls = [];

  for (const att of message.attachments.values()) {
    if (att.url) urls.push(att.url);
  }

  const linkRegex = /(https?:\/\/[^\s]+)/gi;
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    urls.push(match[1]);
  }

  const result = await geminiModerate(text, urls);
  if (!result.unsafe) return;

  if (!guildConfig.punishmentsEnabled) {
    await logEvent(
      message.guild,
      guildConfig,
      "🚨 FilterProtect Detection (No Punishment)",
      `Gemini flagged content as unsafe.\nReason: **${result.reason}**`,
      [
        { name: "User", value: `${message.author.tag} (${message.author.id})`, inline: true },
        { name: "Channel", value: `${message.channel}`, inline: true },
        {
          name: "Severity",
          value: `${result.severity} (1=low, 4=extreme)`,
          inline: true
        },
        {
          name: "Categories",
          value: result.categories.length ? result.categories.join(", ") : "[none]",
          inline: false
        },
        { name: "Content", value: text || "[no text]", inline: false },
        { name: "URLs", value: urls.join("\n") || "[none]", inline: false }
      ]
    );
    return;
  }

  try {
    await message.delete().catch(() => {});

    await message.channel
      .send({
        content: `⚠️ ${message.author}, your message was removed: **${result.reason}**`
      })
      .then(m => setTimeout(() => m.delete().catch(() => {}), 7000));

    const harsh = guildConfig.harshness;

    if (!guildConfig.strikes[message.author.id]) guildConfig.strikes[message.author.id] = 0;

    if (harsh >= 2 || result.severity >= 2) {
      guildConfig.strikes[message.author.id]++;
      saveConfig();
    }

    if ((harsh >= 3 || result.severity >= 3) && message.member) {
      try {
        await message.member.timeout(10 * 60 * 1000, "FilterProtect auto-timeout (Gemini)");
      } catch {}
    }

    if ((harsh === 4 || result.severity === 4) && message.member) {
      const strikes = guildConfig.strikes[message.author.id] || 0;
      if (strikes >= 3) {
        try {
          await message.member.kick("FilterProtect auto-kick (3 strikes, Gemini)");
        } catch {}
      }
    }

    await logEvent(
      message.guild,
      guildConfig,
      "🚨 FilterProtect Action (Gemini)",
      `Gemini flagged content as unsafe.\nReason: **${result.reason}**`,
      [
        { name: "User", value: `${message.author.tag} (${message.author.id})`, inline: true },
        { name: "Channel", value: `${message.channel}`, inline: true },
        {
          name: "Severity",
          value: `${result.severity} (1=low, 4=extreme)`,
          inline: true
        },
        {
          name: "Categories",
          value: result.categories.length ? result.categories.join(", ") : "[none]",
          inline: false
        },
        { name: "Content", value: text || "[no text]", inline: false },
        { name: "URLs", value: urls.join("\n") || "[none]", inline: false }
      ]
    );
  } catch (e) {
    console.error("Punish error:", e);
  }
});

// ---------- Guild Join ----------
client.on(Events.GuildCreate, async guild => {
  ensureGuildConfig(guild.id);
  saveConfig();

  const channel = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased());
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("👋 Welcome to FilterProtect (Gemini)")
    .setDescription(
      "Thanks for adding **FilterProtect**.\n\n" +
        "Use `/setup` (server owner / admins) to configure harshness and logging.\n" +
        "Use `/settings` to toggle scanning and punishments.\n" +
        "Use `/log` to manually log and strike any user.\n" +
        "All messages, links, images, and attachments are scanned by **Gemini**."
    )
    .setColor("#5865F2");

  await channel.send({ embeds: [embed] });
});

// ---------- Login ----------
console.log("Starting FilterProtect...");
console.log("DISCORD_TOKEN present:", !!process.env.DISCORD_TOKEN);
console.log("GEMINI_API_KEY present:", !!process.env.GEMINI_API_KEY);
client.login(process.env.DISCORD_TOKEN);
