} catch (error) {
  const errorMessage =
    error instanceof Error
      ? error.message
      : (() => {
          try {
            return JSON.stringify(error);
          } catch {
            return String(error);
          }
        })();

  console.error('OCR pipeline failed:', error);

  await supabaseAdmin
    .from('source_images')
    .update({
      ocr_status: 'failed',
      error_message: errorMessage || 'OCR failed with empty error message'
    })
    .eq('id', image.id);
}
