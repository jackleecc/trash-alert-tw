import { createClient } from '@supabase/supabase-js';

/**
 * 建立並匯出 Supabase 客戶端實例。
 * 使用 Service Role Key 以取得完整的資料庫寫入權限。
 */
const supabaseUrl =
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-role-key';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(
      '[Supabase] 警告：環境變數 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 未設定，使用預設占位符。'
    );
  }
}

export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    // 伺服器端不需要自動重新整理 Session
    persistSession: false,
    autoRefreshToken: false,
  },
});

