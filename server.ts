import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { scoreLeadsWithGemini } from './src/server/aiScorer.ts';
import { verifyBusinessWebPresenceWithSearch } from './src/server/aiSearchGrounding.ts';
import {
  buildLeadsCsv,
  clearGoogleSheetsConfig,
  createAutoProspectRule,
  deleteAutoProspectRule,
  deleteLeadRecord,
  getGoogleSheetsConfig,
  getOutreachSettings,
  insertCampaign,
  isValidPipelineStatus,
  listAutoProspectDigests,
  listAutoProspectRules,
  listCampaigns,
  markAllAutoProspectDigestsRead,
  markAutoProspectDigestRead,
  queryLeads,
  recordAutoProspectRun,
  saveGoogleSheetsConfig,
  saveOutreachSettings,
  updateAutoProspectRule,
  updateLeadRecord,
  updateLeadScoresInDb,
  upsertLeadsBulk,
} from './src/server/db.ts';
import type {
  AiScoreRequestItem,
  AutoProspectFrequency,
  LeadRecord,
} from './src/types/leads.ts';

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/campaigns', (_req, res) => {
    try {
      const campaigns = listCampaigns(50);
      res.json({ campaigns });
    } catch (error) {
      console.error('Erro ao listar campanhas:', error);
      res.status(500).json({ error: 'Falha ao carregar histórico de campanhas.' });
    }
  });

  app.post('/api/campaigns', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const niche = typeof body.niche === 'string' ? body.niche.trim() : '';
      const city = typeof body.city === 'string' ? body.city.trim() : '';
      const province = typeof body.province === 'string' ? body.province.trim() : '';

      if (!id || !niche || !city || !province) {
        res.status(400).json({ error: 'Campos obrigatórios da campanha em falta.' });
        return;
      }

      const campaign = insertCampaign({
        id,
        niche,
        city,
        province,
        totalFound: Number(body.totalFound) || 0,
        qualifiedCount: Number(body.qualifiedCount) || 0,
        createdAt: typeof body.createdAt === 'string' ? body.createdAt : new Date().toISOString(),
      });

      res.status(201).json({ campaign });
    } catch (error) {
      console.error('Erro ao registar campanha:', error);
      res.status(500).json({ error: 'Falha ao guardar campanha de mineração.' });
    }
  });

  app.get('/api/leads', (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'all';
      const city = typeof req.query.city === 'string' ? req.query.city : 'all';
      const qualifiedOnly = req.query.qualifiedOnly === 'true';
      const search = typeof req.query.search === 'string' ? req.query.search : '';

      const leads = queryLeads({ status, city, qualifiedOnly, search });
      res.json({ leads, total: leads.length });
    } catch (error) {
      console.error('Erro ao listar leads:', error);
      res.status(500).json({ error: 'Falha ao consultar leads guardados.' });
    }
  });

  app.post('/api/leads/bulk', (req, res) => {
    try {
      const body = req.body as { leads?: unknown };
      if (!Array.isArray(body.leads) || body.leads.length === 0) {
        res.status(400).json({ error: 'Envie uma lista válida de leads para guardar.' });
        return;
      }

      const validLeads = body.leads.filter(
        (item): item is LeadRecord =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as LeadRecord).placeId === 'string' &&
          (item as LeadRecord).placeId.trim().length > 0
      );

      if (validLeads.length === 0) {
        res.status(400).json({ error: 'Nenhum lead válido encontrado no pedido.' });
        return;
      }

      const saved = upsertLeadsBulk(validLeads.slice(0, 100));
      res.status(201).json({ leads: saved, count: saved.length });
    } catch (error) {
      console.error('Erro ao guardar leads em lote:', error);
      res.status(500).json({ error: 'Falha ao guardar leads na base de dados.' });
    }
  });

  app.patch('/api/leads/:placeId', (req, res) => {
    try {
      const placeId = req.params.placeId;
      const body = req.body as Record<string, unknown>;

      if (body.pipelineStatus !== undefined && !isValidPipelineStatus(body.pipelineStatus)) {
        res.status(400).json({ error: 'Estado do funil inválido.' });
        return;
      }

      const updated = updateLeadRecord(placeId, {
        pipelineStatus: isValidPipelineStatus(body.pipelineStatus)
          ? body.pipelineStatus
          : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
        opportunityScore:
          typeof body.opportunityScore === 'number' || body.opportunityScore === null
            ? body.opportunityScore
            : undefined,
        scoreRationale:
          typeof body.scoreRationale === 'string' || body.scoreRationale === null
            ? body.scoreRationale
            : undefined,
      });

      if (!updated) {
        res.status(404).json({ error: 'Lead não encontrado.' });
        return;
      }

      res.json({ lead: updated });
    } catch (error) {
      console.error('Erro ao atualizar lead:', error);
      res.status(500).json({ error: 'Falha ao atualizar lead.' });
    }
  });

  app.delete('/api/leads/:placeId', (req, res) => {
    try {
      const removed = deleteLeadRecord(req.params.placeId);
      if (!removed) {
        res.status(404).json({ error: 'Lead não encontrado.' });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      console.error('Erro ao remover lead:', error);
      res.status(500).json({ error: 'Falha ao remover lead.' });
    }
  });

  app.get('/api/leads/export', (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'all';
      const city = typeof req.query.city === 'string' ? req.query.city : 'all';
      const qualifiedOnly = req.query.qualifiedOnly === 'true';
      const search = typeof req.query.search === 'string' ? req.query.search : '';

      const leads = queryLeads({ status, city, qualifiedOnly, search });
      const csv = buildLeadsCsv(leads);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="minera-ia-leads-mocambique.csv"'
      );
      res.send(csv);
    } catch (error) {
      console.error('Erro ao exportar CSV:', error);
      res.status(500).json({ error: 'Falha ao gerar exportação CSV.' });
    }
  });

  app.post('/api/ai/score-leads', async (req, res) => {
    try {
      const body = req.body as { leads?: unknown };
      if (!Array.isArray(body.leads) || body.leads.length === 0) {
        res.status(400).json({ error: 'Forneça uma lista de leads para pontuação.' });
        return;
      }

      const items = body.leads.filter(
        (item): item is AiScoreRequestItem =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as AiScoreRequestItem).placeId === 'string' &&
          typeof (item as AiScoreRequestItem).name === 'string'
      );

      if (items.length === 0) {
        res.status(400).json({ error: 'Nenhum item válido para avaliação.' });
        return;
      }

      const scores = await scoreLeadsWithGemini(items);
      updateLeadScoresInDb(scores);
      res.json({ scores });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Falha na pontuação de oportunidade com IA.';
      console.error('Erro na rota /api/ai/score-leads:', error);
      res.status(502).json({ error: message });
    }
  });

  app.post('/api/ai/web-check', async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const city = typeof body.city === 'string' ? body.city.trim() : '';

      if (!name || !city) {
        res.status(400).json({ error: 'Nome da empresa e cidade são obrigatórios.' });
        return;
      }

      const result = await verifyBusinessWebPresenceWithSearch({
        name,
        city,
        niche: typeof body.niche === 'string' ? body.niche.trim() : undefined,
        province: typeof body.province === 'string' ? body.province.trim() : undefined,
        address: typeof body.address === 'string' ? body.address.trim() : undefined,
        phoneRaw: typeof body.phoneRaw === 'string' ? body.phoneRaw.trim() : null,
        websiteStatus:
          typeof body.websiteStatus === 'string' ? body.websiteStatus.trim() : undefined,
        websiteUrl: typeof body.websiteUrl === 'string' ? body.websiteUrl.trim() : null,
      });

      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Falha ao consultar Pesquisa Google com IA.';
      console.error('Erro na rota /api/ai/web-check:', error);
      res.status(502).json({ error: message });
    }
  });

  // Auto-Prospecção: recurring searches & weekly summary digests
  app.get('/api/auto-prospect/rules', (_req, res) => {
    try {
      const rules = listAutoProspectRules();
      res.json({ rules });
    } catch (error) {
      console.error('Erro ao listar regras de Auto-Prospecção:', error);
      res.status(500).json({ error: 'Falha ao carregar regras de Auto-Prospecção.' });
    }
  });

  app.post('/api/auto-prospect/rules', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      const city = typeof body.city === 'string' ? body.city.trim() : '';
      const province = typeof body.province === 'string' ? body.province.trim() : '';
      const frequency: AutoProspectFrequency =
        body.frequency === 'daily' ? 'daily' : 'weekly';
      const dayOfWeek =
        typeof body.dayOfWeek === 'number' && Number.isFinite(body.dayOfWeek)
          ? Math.max(0, Math.min(6, Math.trunc(body.dayOfWeek)))
          : 1;
      const recipientEmail =
        typeof body.recipientEmail === 'string' ? body.recipientEmail.trim() : '';
      const onlyWithoutWebsite = body.onlyWithoutWebsite !== false;

      if (!query || !city || !province) {
        res.status(400).json({ error: 'Indique actividade, cidade e província.' });
        return;
      }

      const rule = createAutoProspectRule({
        query,
        city,
        province,
        frequency,
        dayOfWeek,
        recipientEmail,
        onlyWithoutWebsite,
      });

      res.status(201).json({ rule });
    } catch (error) {
      console.error('Erro ao criar regra de Auto-Prospecção:', error);
      res.status(500).json({ error: 'Falha ao guardar regra de Auto-Prospecção.' });
    }
  });

  app.patch('/api/auto-prospect/rules/:id', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const updated = updateAutoProspectRule(req.params.id, {
        isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
        frequency:
          body.frequency === 'daily' || body.frequency === 'weekly'
            ? body.frequency
            : undefined,
        dayOfWeek:
          typeof body.dayOfWeek === 'number' && Number.isFinite(body.dayOfWeek)
            ? Math.max(0, Math.min(6, Math.trunc(body.dayOfWeek)))
            : undefined,
        recipientEmail:
          typeof body.recipientEmail === 'string' ? body.recipientEmail : undefined,
      });
      if (!updated) {
        res.status(404).json({ error: 'Regra de Auto-Prospecção não encontrada.' });
        return;
      }
      res.json({ rule: updated });
    } catch (error) {
      console.error('Erro ao atualizar regra de Auto-Prospecção:', error);
      res.status(500).json({ error: 'Falha ao atualizar regra.' });
    }
  });

  app.delete('/api/auto-prospect/rules/:id', (req, res) => {
    try {
      const deleted = deleteAutoProspectRule(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'Regra não encontrada.' });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      console.error('Erro ao remover regra:', error);
      res.status(500).json({ error: 'Falha ao remover regra.' });
    }
  });

  app.post('/api/auto-prospect/rules/:id/complete-run', (req, res) => {
    try {
      const body = req.body as { leads?: unknown };
      const scannedLeads = Array.isArray(body.leads)
        ? body.leads.filter(
            (item): item is LeadRecord =>
              Boolean(item) &&
              typeof item === 'object' &&
              typeof (item as LeadRecord).placeId === 'string'
          )
        : [];

      const outcome = recordAutoProspectRun(req.params.id, scannedLeads);
      if (!outcome) {
        res.status(404).json({ error: 'Regra de Auto-Prospecção não encontrada.' });
        return;
      }
      res.status(201).json(outcome);
    } catch (error) {
      console.error('Erro ao registar execução de Auto-Prospecção:', error);
      res.status(500).json({ error: 'Falha ao processar resumo da pesquisa recorrente.' });
    }
  });

  app.get('/api/auto-prospect/digests', (_req, res) => {
    try {
      const digests = listAutoProspectDigests(30);
      res.json({ digests });
    } catch (error) {
      console.error('Erro ao listar resumos de Auto-Prospecção:', error);
      res.status(500).json({ error: 'Falha ao carregar notificações e resumos.' });
    }
  });

  app.post('/api/auto-prospect/digests/read-all', (_req, res) => {
    try {
      markAllAutoProspectDigestsRead();
      res.json({ ok: true });
    } catch (error) {
      console.error('Erro ao marcar notificações como lidas:', error);
      res.status(500).json({ error: 'Falha ao atualizar notificações.' });
    }
  });

  app.post('/api/auto-prospect/digests/:id/read', (req, res) => {
    try {
      const ok = markAutoProspectDigestRead(req.params.id);
      if (!ok) {
        res.status(404).json({ error: 'Notificação não encontrada.' });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      console.error('Erro ao marcar notificação como lida:', error);
      res.status(500).json({ error: 'Falha ao atualizar notificação.' });
    }
  });

  // Google Sheets Sync Configuration (non-secret spreadsheet metadata only)
  app.get('/api/integrations/sheets', (_req, res) => {
    try {
      const config = getGoogleSheetsConfig();
      res.json({ config });
    } catch (error) {
      console.error('Erro ao carregar configuração do Google Sheets:', error);
      res.status(500).json({ error: 'Falha ao carregar configuração do Google Sheets.' });
    }
  });

  app.put('/api/integrations/sheets', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const spreadsheetId =
        typeof body.spreadsheetId === 'string' ? body.spreadsheetId.trim() : '';
      const spreadsheetTitle =
        typeof body.spreadsheetTitle === 'string' ? body.spreadsheetTitle.trim() : '';
      const spreadsheetUrl =
        typeof body.spreadsheetUrl === 'string' ? body.spreadsheetUrl.trim() : '';
      const sheetName = typeof body.sheetName === 'string' ? body.sheetName.trim() : '';

      if (!spreadsheetId || !sheetName) {
        res.status(400).json({ error: 'ID da planilha e nome da aba são obrigatórios.' });
        return;
      }

      const config = saveGoogleSheetsConfig({
        spreadsheetId,
        spreadsheetTitle: spreadsheetTitle || 'Planilha Google Sheets',
        spreadsheetUrl,
        sheetName,
        autoSyncEnabled:
          typeof body.autoSyncEnabled === 'boolean' ? body.autoSyncEnabled : undefined,
        lastSyncedAt:
          typeof body.lastSyncedAt === 'string' || body.lastSyncedAt === null
            ? body.lastSyncedAt
            : undefined,
        lastSyncedCount:
          typeof body.lastSyncedCount === 'number' && Number.isFinite(body.lastSyncedCount)
            ? body.lastSyncedCount
            : undefined,
      });

      res.json({ config });
    } catch (error) {
      console.error('Erro ao guardar configuração do Google Sheets:', error);
      res.status(500).json({ error: 'Falha ao guardar configuração do Google Sheets.' });
    }
  });

  app.delete('/api/integrations/sheets', (_req, res) => {
    try {
      clearGoogleSheetsConfig();
      res.json({ ok: true });
    } catch (error) {
      console.error('Erro ao desligar configuração do Google Sheets:', error);
      res.status(500).json({ error: 'Falha ao desligar planilha.' });
    }
  });

  app.get('/api/settings/outreach', (_req, res) => {
    try {
      const settings = getOutreachSettings();
      res.json({ settings });
    } catch (error) {
      console.error('Erro ao carregar e-mail de envio:', error);
      res.status(500).json({ error: 'Falha ao carregar configuração de envio.' });
    }
  });

  app.put('/api/settings/outreach', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const senderEmail =
        typeof body.senderEmail === 'string' ? body.senderEmail.trim() : '';
      if (!senderEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
        res.status(400).json({ error: 'Indique um endereço de e-mail válido para envio.' });
        return;
      }
      const settings = saveOutreachSettings(senderEmail);
      res.json({ settings });
    } catch (error) {
      console.error('Erro ao guardar e-mail de envio:', error);
      res.status(500).json({ error: 'Falha ao guardar configuração de envio.' });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build not found.');
      }
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Minera.ia server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
