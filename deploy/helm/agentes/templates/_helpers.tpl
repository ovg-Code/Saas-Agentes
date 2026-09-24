{{- define "agentes.labels" -}}
app.kubernetes.io/part-of: agentes
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "agentes.dbEnv" -}}
{{- if .Values.database.existingSecret }}
- name: DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ .Values.database.existingSecret }}, key: DATABASE_URL } }
- name: DATABASE_ADMIN_URL
  valueFrom: { secretKeyRef: { name: {{ .Values.database.existingSecret }}, key: DATABASE_ADMIN_URL } }
{{- else }}
- { name: DATABASE_URL, value: {{ .Values.database.url | quote }} }
- { name: DATABASE_ADMIN_URL, value: {{ .Values.database.adminUrl | quote }} }
{{- end }}
{{- end }}

{{- define "agentes.runtimeEnv" -}}
{{ include "agentes.dbEnv" . }}
- { name: LLM_PROVIDER, value: {{ .Values.llm.provider | quote }} }
- { name: LLM_BASE_URL, value: {{ .Values.llm.baseUrl | quote }} }
- { name: EMBEDDINGS_PROVIDER, value: {{ .Values.llm.embeddingsProvider | quote }} }
- { name: CONTROL_PLANE_URL, value: "http://{{ .Release.Name }}-api:8080" }
- { name: TEMPORAL_ADDRESS, value: {{ .Values.temporal.address | quote }} }
- { name: TEMPORAL_NAMESPACE, value: {{ .Values.temporal.namespace | quote }} }
- { name: TEMPORAL_TASK_QUEUE, value: {{ .Values.temporal.taskQueue | quote }} }
- name: LLM_API_KEY
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.existingSecret }}, key: LLM_API_KEY } }
- name: INTERNAL_TOKEN
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.existingSecret }}, key: INTERNAL_TOKEN } }
{{- end }}
