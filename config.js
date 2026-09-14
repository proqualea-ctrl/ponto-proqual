// =============================================================
// CONFIGURAÇÃO — preenche com os dados do TEU projeto Supabase
// (Project Settings -> API, no painel do Supabase)
// =============================================================
window.APP_CONFIG = {
  SUPABASE_URL: "https://jvmrsgrfkfafueyfqziy.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2bXJzZ3Jma2ZhZnVleWZxeml5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxMjc1NTAsImV4cCI6MjEwNDcwMzU1MH0.xmsxUGIjvWi9NEAYujr6j_vsQHJlvUEZo4sTDPCysZ8",

  COMPANY_NAME: "PROQUAL Engenheiros e Associados, Lda",
  COMPANY_TAGLINE: "O Futuro com Precisão",
  // Preenche estes dois para aparecerem no cabeçalho dos relatórios Excel
  // (ficam de fora automaticamente se deixares em branco).
  COMPANY_NUIT: "",       // ex: "400123456"
  COMPANY_ADDRESS: "",    // ex: "Av. Julius Nyerere, 1234, Maputo"
  APP_TITLE: "Ponto PROQUAL",
  APP_SUBTITLE: "Foto, hora e localização carimbadas no momento do registo.",

  // bucket criado pelo supabase/schema.sql
  STORAGE_BUCKET: "presencas-fotos",
};
