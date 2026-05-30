// =========================
// FilterProtect — Clean Version
// =========================

require("dotenv").config();
const fetch = (...args) => import("node-fetch").then(({default: fetch}) => fetch(...args));
const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("FilterProtect is running."));
app.listen(process.env.PORT || 3000);

const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField
} = require("discord.js");

const fs = require("fs");

// =========================
// CONFIG SYSTEM
// =========================

const CONFIG_FILE = "./config.json";
let config = fs.existsSync(CONFIG_FILE)
  ? JSON.parse(fs.readFileSync(CONFIG_FILE))
  : { guilds: {} };

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function ensureGuild(gid) {
  if (!config.guilds[gid]) {
    config.guilds[gid] = {
      strikes: {},
      harshness: 2,
      autoKick: true,
      scanning: true,
      punishments: true,
      logsChannel: null
    };
  }
  return config.guilds[gid];
}

// =========================
// DISCORD CLIENT
// =========================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
});

// =========================
// GEMINI AI — FIXED ENDPOINT
// =========================

async function geminiModerate(text, urls) {
  const prompt = `
You are a Discord moderation AI. Analyze the message and return ONLY JSON:

{
  "unsafe": true/false,
  "severity": 1-4,
  "reason": "short reason"
}

Message:
${text}

Attachments:
${urls.join("\n")}
`;

  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
        process.env.GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await res.json();
    const raw =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      '{"unsafe":false,"severity":1,"reason":"no response"}';

    return JSON.parse(raw);
  } catch (err) {
    console.log("Gemini error:", err);
    return { unsafe: false, severity: 1, reason: "Gemini error" };
  }
}

// =========================
// LOGGING
// =========================

async function logEvent(guild, cfg, title, desc) {
  let ch = cfg.logsChannel
    ? guild.channels.cache.get(cfg.logsChannel)
    : null;

  if (!ch) {
    ch = await guild.channels.create({
      name: "filterprotect-logs",
      type: 0
    });
    cfg.logsChannel = ch.id;
    saveConfig();
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor("#ff4444")
    .setTimestamp();

  ch.send({ embeds: [embed] });
}

// =========================
// SLASH COMMANDS
// =========================

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("settings")
      .setDescription("Open FilterProtect settings panel")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("log")
      .setDescription("Log a user and add a strike")
      .addUserOption(o =>
        o.setName("user").setDescription("User").setRequired(true)
      )
      .addStringOption(o =>
        o.setName("reason").setDescription("Reason").setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("strikes")
      .setDescription("View strikes for a user")
      .addUserOption(o =>
        o.setName("user").setDescription("User").setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("removestrike")
      .setDescription("Remove strikes from a user")
      .addUserOption(o =>
        o.setName("user").setDescription("User").setRequired(true)
      )
      .addIntegerOption(o =>
        o.setName("amount").setDescription("Amount").setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("purge")
      .setDescription("Bulk delete messages")
      .addIntegerOption(o =>
        o.setName("amount").setDescription("Amount").setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("timeout")
      .setDescription("Timeout a user")
      .addUserOption(o =>
        o.setName("user").setDescription("User").setRequired(true)
      )
      .addIntegerOption(o =>
        o.setName("minutes").setDescription("Minutes").setRequired(true)
      )
      .addStringOption(o =>
        o.setName("reason").setDescription("Reason").setRequired(true)
      )
      .toJSON()
  ];

  await client.application.commands.set(commands);
});

// =========================
// SETTINGS PANEL (BUTTONS)
// =========================

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

  const gid = interaction.guild.id;
  const cfg = ensureGuild(gid);

  // SETTINGS PANEL
  if (interaction.isChatInputCommand() && interaction.commandName === "settings") {
    const embed = new EmbedBuilder()
      .setTitle("⚙️ FilterProtect Settings")
      .setColor("#5865F2")
      .setDescription(
        `**AI Scanning:** ${cfg.scanning ? "🟢 ON" : "🔴 OFF"}\n` +
        `**Punishments:** ${cfg.punishments ? "🟢 ON" : "🔴 OFF"}\n` +
        `**Auto‑Kick at 3 Strikes:** ${cfg.autoKick ? "🟢 ON" : "🔴 OFF"}\n` +
        `**Harshness:** ${cfg.harshness} (1–4)`
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("toggle_scanning")
        .setLabel("Toggle Scanning")
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId("toggle_punish")
        .setLabel("Toggle Punishments")
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId("toggle_autokick")
        .setLabel("Toggle AutoKick")
        .setStyle(ButtonStyle.Danger)
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("harsh_down")
        .setLabel("Harshness -")
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId("harsh_up")
        .setLabel("Harshness +")
        .setStyle(ButtonStyle.Secondary)
    );

    return interaction.reply({
      embeds: [embed],
      components: [row, row2],
      ephemeral: true
    });
  }

  // BUTTON HANDLING
  if (interaction.isButton()) {
    if (interaction.customId === "toggle_scanning") cfg.scanning = !cfg.scanning;
    if (interaction.customId === "toggle_punish") cfg.punishments = !cfg.punishments;
    if (interaction.customId === "toggle_autokick") cfg.autoKick = !cfg.autoKick;
    if (interaction.customId === "harsh_down") cfg.harshness = Math.max(1, cfg.harshness - 1);
    if (interaction.customId === "harsh_up") cfg.harshness = Math.min(4, cfg.harshness + 1);

    saveConfig();

    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚙️ FilterProtect Settings")
          .setColor("#5865F2")
          .setDescription(
            `**AI Scanning:** ${cfg.scanning ? "🟢 ON" : "🔴 OFF"}\n` +
            `**Punishments:** ${cfg.punishments ? "🟢 ON" : "🔴 OFF"}\n` +
            `**Auto‑Kick at 3 Strikes:** ${cfg.autoKick ? "🟢 ON" : "🔴 OFF"}\n` +
            `**Harshness:** ${cfg.harshness} (1–4)`
          )
      ],
      components: interaction.message.components
    });
  }

  // =========================
  // MODERATION COMMANDS
  // =========================

  if (interaction.commandName === "log") {
    const user = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");

    cfg.strikes[user.id] = (cfg.strikes[user.id] || 0) + 1;
    saveConfig();

    await logEvent(interaction.guild, cfg, "Manual Log", `${user.tag} — ${reason}`);
    return interaction.reply({ content: `Logged ${user.tag}`, ephemeral: true });
  }

  if (interaction.commandName === "strikes") {
    const user = interaction.options.getUser("user");
    const count = cfg.strikes[user.id] || 0;
    return interaction.reply({ content: `${user.tag} has ${count} strikes.`, ephemeral: true });
  }

  if (interaction.commandName === "removestrike") {
    const user = interaction.options.getUser("user");
    const amt = interaction.options.getInteger("amount");

    cfg.strikes[user.id] = Math.max(0, (cfg.strikes[user.id] || 0) - amt);
    saveConfig();

    return interaction.reply({ content: `Removed ${amt} strikes from ${user.tag}.`, ephemeral: true });
  }

  if (interaction.commandName === "purge") {
    const amt = interaction.options.getInteger("amount");
    const channel = interaction.channel;

    await channel.bulkDelete(amt, true);
    return interaction.reply({ content: `Purged ${amt} messages.`, ephemeral: true });
  }

  if (interaction.commandName === "timeout") {
    const user = interaction.options.getUser("user");
    const mins = interaction.options.getInteger("minutes");
    const reason = interaction.options.getString("reason");

    const member = interaction.guild.members.cache.get(user.id);
    await member.timeout(mins * 60 * 1000, reason);

    return interaction.reply({ content: `Timed out ${user.tag} for ${mins} minutes.`, ephemeral: true });
  }
});

// =========================
// AI MODERATION
// =========================

client.on("messageCreate", async msg => {
  if (!msg.guild || msg.author.bot) return;

  const cfg = ensureGuild(msg.guild.id);
  if (!cfg.scanning) return;

  const urls = [...msg.attachments.values()].map(a => a.url);

  const result = await geminiModerate(msg.content, urls);
  if (!result.unsafe) return;

  // Delete message
  await msg.delete().catch(() => {});

  // Add strike
  if (cfg.punishments) {
    cfg.strikes[msg.author.id] = (cfg.strikes[msg.author.id] || 0) + 1;
    saveConfig();
  }

  // Auto-kick
  if (cfg.autoKick && cfg.strikes[msg.author.id] >= 3) {
    const member = msg.guild.members.cache.get(msg.author.id);
    await member.kick("Auto-kick: 3 strikes").catch(() => {});
  }

  // Log
  await logEvent(
    msg.guild,
    cfg,
    "AI Moderation",
    `${msg.author.tag} — ${result.reason}`
  );
});

// =========================
// LOGIN
// =========================

client.login(process.env.DISCORD_TOKEN);
